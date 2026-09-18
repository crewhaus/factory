# @crewhaus/tool-changeset

Everything you can decide about a change set before it becomes a pull request.

| Tool | Answers |
|---|---|
| `DiffLint` | does this change add anything the team already decided it does not want |
| `DocsSymbolCheck` | do the docs still name things the code still has |

Both are review passes, and a review pass earns its place by being boring:
the same change set produces the same findings every time, with no opinion
about whether the code is any good.

## DiffLint reads added lines only

A change set is not a codebase. A linter that reports the `console.log`
somebody else left behind three years ago gets turned off in a week, and then
it catches nothing at all. `DiffLint` runs its rules on `+` lines and on
nothing else — not on context, not on removals, not on the rest of the file.

**Every finding carries the line number in the NEW file.** That number is the
product: it is what lets a caller fix the finding without re-reading anything
first. It comes from `parseUnifiedDiff` in
[`@crewhaus/tool-text`](https://github.com/crewhaus/factory/tree/main/packages/tool-text),
which is the one diff parser in this repository. A second parser would mean a
second numbering, and one of the two would be wrong.

The rules:

| Rule | Severity | Applies to |
|---|---|---|
| `conflictMarker` | error | every text file |
| `debugger` | error | JavaScript and TypeScript |
| `focusedTest` | error | JavaScript and TypeScript (`.only`, `fit`, `fdescribe`) |
| `consoleLog` | warning | JavaScript and TypeScript (`log`/`debug`/`dir`/`trace`) |
| `suppression` | warning | `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, `# type: ignore`, in a comment |
| `ticketlessTodo` | warning | a TODO/FIXME/HACK/XXX that opens a comment, with no ticket or URL |
| `machinePath` | error / warning | a home directory (error), a temp directory (warning) |
| `crlf` | warning | one finding per file, with the count |
| `longLine` | warning | an added line over 1000 characters |
| `oversizedFile` | warning | a file adding more than 800 lines |
| `commentedCode` | warning | **off by default** — see below |

Disable any of them by name with `disable`, and turn the opt-in ones on with
`enable`. An id that is not a rule is rejected by the schema rather than
ignored, because a typo that silently disables nothing is how a team ends up
believing a rule has been running for a year.

### Where the comment starts is most of the precision

With the whole file in hand the honest way to tell code from commentary is a
mask — `maskSource` in `@crewhaus/tool-code` does exactly that, which is how
`TodoScan` ignores string literals. With one line in hand, the position of the
first comment opener is what there is, and it carries three rules:

- `debugger`, `focusedTest` and `consoleLog` are STATEMENTS, so a match at or
  after the opener is not one. That silences the trailing `// debugger;` and
  the `"// debugger;"` in a test fixture alike.
- A suppression directive only suppresses inside a comment. `@ts-ignore` in a
  rule table, a string or a test name is talk *about* one.
- A TODO marker has to OPEN the comment. `// TODO: fix this` is a note to a
  maintainer; "a TODO with no ticket is how work gets lost", mid-sentence, is
  prose about todos — and prose about todos is what a repository's comments
  are full of.

Each of these is wrong in one direction only: an opener inside a string
literal reads as a comment, so the rule goes quiet. That is the direction to
be wrong in.

Two rules are deliberately absent. `@ts-expect-error` is not reported: it
fails once the error it covers is gone, which is the behaviour to encourage.
`biome-ignore` is not reported either — its syntax already requires a stated
reason.

### The commented-out-code rule is a heuristic, and ships as one

`commentedCode` guesses. It fires on a comment whose body has a code shape —
a statement keyword, an assignment, a bare call, a line ending in `;`, `{` or
`}` — and it vetoes anything that reads like a sentence. That veto is a word
count rather than a word list, because a comment in German is still prose.

It still has a real false-positive rate: `// see runTests()` is a note, not
dead code. So it is **opt-in**, it warns rather than errors, and it never runs
on config files or markdown, where a commented-out key looks exactly like a
commented-out statement. A lint that cries wolf gets disabled wholesale, and a
disabled lint finds nothing.

### What it skips, and what it deliberately does not

- **Binary stanzas** are skipped and reported as skipped.
- **A pure rename** has no content to scan, so there is nothing to say.
- **A rename WITH edits is scanned.** This is a deliberate departure from the
  obvious "skip renames" rule: git reports a move-plus-edit as a rename whose
  hunks hold only the lines that really changed, and those lines are new code.
  Skipping them would make a `debugger` added while moving a file the one
  finding a review never sees.
- **A combined (merge) diff** cannot be numbered per parent, so the parser
  refuses it and the refusal is returned as a warning. A change set that was
  only partly readable never comes back as `clean`.

### Limits worth knowing

- **A rule sees one line, without the file around it.** `console.log(` inside
  a multi-line string literal reads exactly like a call. The rules are
  anchored tightly and lean toward silence, but this is the honest limit of
  linting a diff rather than a file.
- **Language is guessed from the extension**, which is all a diff carries.
- **A fixture that contains a rule's own pattern is reported.** This package's
  tests are the clearest example: `'it.only("x")'` inside a string is a
  fixture, and `DiffLint` run over this package reports it. Exclude test paths
  with `paths`, or read the finding and move on.
- **`=======` alone is not a conflict marker.** It underlines a markdown
  heading and divides half the ASCII art in the world, so it only counts in a
  file that also gained an unmistakable `<<<<<<<` or `>>>>>>>`.
- **A CRLF diff transported as CRLF cannot be detected.** When every line of
  the patch ends in `\r`, including its headers, the line endings belong to
  the transport and the parser strips them. The rule then reports nothing —
  a miss, never a false positive.

### Where the diff comes from

Pass `diff` text when you already have the patch; nothing is spawned. Pass a
git selector (`cwd`, `ref`, `range`, `staged`, `paths`) and the tool runs
`git diff --no-ext-diff -U0` for you — `-U0` because context lines are bytes
nobody here reads. Passing both is refused: with the text in hand there is
nothing for git to do.

The tool declares `scope: "external"` and `ioCapability: "process"` whichever
way it is called. A static flag describes the worst case, and a capability
that is sometimes true is true.

A ref or range that begins with `-` is refused, because git would read it as
an option and `git diff --output=<file>` writes anywhere on the disk. A
pathspec that is absolute, contains `..` or starts with git's `:` magic is
refused for the same reason. The directory git runs in is resolved against
the workspace root, symlinks included.

## DocsSymbolCheck is built to under-report

A missed stale symbol costs a reader a confusing minute. A wrong "this symbol
is gone" costs the tool its readers — and a tool nobody reads catches nothing.
Every decision here is taken in the direction of saying less.

**What counts as a symbol reference** is narrow, and it is the answer to the
question this tool has to get right:

1. A **named import inside a fenced code block**, from a project-local module
   (a relative specifier, or one matching `localPrefixes`). The writer named
   the module and the export together, so there is nothing to infer.
   `import { a as b }` records `a`: the alias is the document's invention.
2. A **backticked identifier in prose**, if it survives the shape filters: at
   least 4 characters, not in the stoplist, and shaped like an API name —
   camelCase, PascalCase, an underscore, a `$`, a member path, or written as a
   call. `` `build` `` is skipped; `` `build()` `` is not. Set
   `requireDistinctive: false` to take the plain words too.

Everything else inside a fence is ignored: a fence usually holds shell
commands, sample output or JSON, and mining it for identifiers produces
exactly the noise this tool exists not to produce.

**What counts as "still exists"** is wide. The question asked of the source
tree is *does this identifier appear anywhere at all* — in code, in a comment,
in a string literal, in a config file. A symbol that survives only as a string
key is not reported. This is why the tool does not parse the sources: a parser
answers the narrower "is it declared", and every narrowing is a new way to be
wrong out loud. `SymbolOutline` and `AstQuery` in
[`@crewhaus/tool-code`](https://github.com/crewhaus/factory/tree/main/packages/tool-code)
are the tools for the declaration question.

A reference to another package's API resolves only if that package is inside
`source`. Running this tool over this package's own README reports `TodoScan`,
which lives in `@crewhaus/tool-code` — a true statement about a narrow
`source`, and the reason `ignore` exists.

For a member path, only the head is checked. If `Foo` exists but `Foo.bar`
does not, the tool says nothing rather than guessing at a method it cannot see
lexically.

### The wrong-tree guard

The most expensive failure this tool has is being pointed at the wrong source
tree and confidently reporting every symbol in a document as deleted. So a
document must resolve at least a quarter of its references (`minResolvedRatio`)
before any of its misses are reported. Below that, the document is reported as
probably describing a different tree and its findings are withheld with the
count and the reason. The guard is per document, so one stray page does not
silence a good one, and `reportUnmatchedDocs` turns it off for a caller who
knows better.

### It refuses rather than guess

An incomplete index invents missing symbols, so a scan that could not read the
whole tree is refused by name:

- more source files than `maxFiles` — the index is short, and a symbol it
  never read reads as deleted;
- a directory under `source` that could not be listed — the largest hole an
  index can have, and everything inside it would be reported as gone;
- a source file too large to read — the last two are refused unless
  `allowUnreadableSources` says the gap is acceptable, in which case the gap
  is reported as a warning;
- no source files at all under `source` — every documented symbol would look
  deleted.

Each refusal is a sentence naming what to change.

What is reported as a warning instead, because it under-reports rather than
invents: a document walk that stopped at its own 500-file cap, a `missing`
list cut by `maxFindings` (`findingsTruncated`), and a symlink that points out
of the workspace.

### Containment survives the walk, not just the path you typed

`docs` and `source` are resolved against the workspace root, symlinks
included. So is every symlinked file the walk *finds* underneath them:
`readFileSync` follows a link, and this tool quotes a document's own line back
in `context`, so a `docs/notes.md -> ~/.ssh/known_hosts` would be a read of a
file outside the workspace and an echo of its contents. Such a link is named
in the warnings and never opened. A symlinked directory is not walked at all.

## What this package does not do

- **It does not decide whether a change is good.** No complexity scores, no
  style opinions, no "consider extracting this".
- **It does not fetch anything.** No issue tracker is consulted to see whether
  a TODO's ticket exists; the rule checks that a reference was written down.
- **It does not write.** Both tools are read-only. `DiffLint` runs `git diff`,
  which takes no locks (`GIT_OPTIONAL_LOCKS=0`) and changes nothing.
- **It does not replace the whole-tree tools.** `TodoScan` inventories every
  TODO in a repository; `DiffLint` asks whether *this change* adds one without
  a ticket. Two different questions, deliberately.
