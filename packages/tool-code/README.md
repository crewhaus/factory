# @crewhaus/tool-code

Code intelligence, build and test — as structured JSON.

Most of these tools drive a project's **own** toolchain rather than
reimplementing it. The value is not a second type checker; it is turning the
noisy, human-facing output of the real one into records a harness can act on
without spending a model turn reading them. A green test run comes back as
three counts. A red one comes back as the failing tests, the assertions, and
the file and line for each — not three thousand lines of terminal.

```yaml
tools:
  - all-code          # every tool below
  - -Format           # ...except the one that rewrites files
```

| Tool | What it does |
|---|---|
| `AstQuery` | Find declarations across a directory by kind, name or export status, with line spans |
| `CoverageSummary` | Turn an lcov or `coverage-summary.json` into per-file percentages, worst first |
| `DeadFileScan` | Files in a directory that nothing else in it imports |
| `DependencyList` | Declared dependencies across package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml |
| `DependencyOutdated` | Where the lockfile and the manifests disagree — npm and cargo only, no registry |
| `Diagnostics` | Type check, lint and format check in ONE normalized diagnostic shape |
| `FindReferences` | Lexical, workspace-wide mentions of an identifier, comments and strings excluded |
| `Format` | Rewrite files with the project's formatter (**the one tool here that writes**) |
| `FormatCheck` | Which files are not formatted, changing none of them |
| `ImportGraph` | The module import graph for a directory, with cycles |
| `Lint` | The project's linter, as diagnostics with file, line, rule and message |
| `PackageScripts` | The scripts a project declares, and the exact command that runs each |
| `RunBuild` | Build, returning diagnostics instead of a build log |
| `RunTests` | Run the suite, return only the failures, structured |
| `StackTraceParse` | A stack trace into frames, each marked project / dependency / runtime |
| `SymbolOutline` | What one file declares, with line ranges — read the outline, then the part you need |
| `TestFailureSummary` | The failures out of test output you already have; runs nothing |
| `TodoScan` | TODO / FIXME / HACK / XXX notes from comments, with author and position |
| `Typecheck` | Type check in no-emit mode, as diagnostics |
| `WorkspacePackages` | Monorepo members and their interdependencies, with cycles |

## Machine-readable by preference

Every runner and checker is asked for the form it documents for scripts, and
the parser that reads it says why in a comment:

| Tool | Form asked for | Why |
|---|---|---|
| tsc | `--pretty false` | pretty mode wraps messages, draws a source excerpt and colours it — all of which move with the terminal width |
| biome | `--reporter=json` | the text reporter frames every finding in box-drawing characters |
| eslint | `-f json` | stylish output pads columns to the longest path in the run |
| ruff | `--output-format json` | concise output drops some messages; JSON always carries code and message |
| vitest / jest | `--reporter=json` / `--json` | one shape serves both, with the failure message and line as fields |
| go | `go test -json` | without it, output cannot be attributed to a test |
| pytest | `-q --no-header -rf --tb=short` | `--json-report` is a third-party plugin most projects do not have |
| bun | the `(fail)` line prefixes | bun's only structured reporter writes a JUnit **file**, and these tools do not drop artefacts into a project |
| cargo | the `test … ok / FAILED` lines | libtest's JSON format is still nightly-only |

## What is lexical, and what that costs

`AstQuery`, `SymbolOutline`, `FindReferences`, `ImportGraph` and
`DeadFileScan` read code with the scanner in `src/lib/scan.ts`. It is a
**scanner, not a parser**: no AST, no types, no scope analysis. Its first pass
does classify every character as code, comment or string, so it is not fooled
by the word `class` inside a docstring or a `//` inside a URL — but it does
not handle:

- JSX/TSX element bodies, which are read as ordinary code
- destructuring declarations (`const { a, b } = x`), recorded with the pattern
  elided rather than one entry per name
- classes nested inside functions, and members of class expressions
- TypeScript overload signatures (reported separately) and computed member
  names (`[Symbol.iterator]`, skipped)
- `declare module "x" { … }` blocks, decorators, `using` declarations
- regex-versus-division in the cases a real grammar would decide

`FindReferences` matches characters, not bindings: a shadowed local, an
unrelated property of the same name and an aliased import are all
indistinguishable to it. `DeadFileScan` is import-based, so it cannot see a
module loaded by a computed path, referenced from HTML, or discovered by
filename convention — treat its output as a list to review, never a list to
delete. `DependencyOutdated` compares the manifest against the **lockfile**
and never contacts a registry, so it can tell you the two disagree but not
that a newer release exists upstream — and it reads four lockfiles
(`bun.lock`, `package-lock.json`, `yarn.lock`, `Cargo.lock`), so a Python or
Go dependency comes back in `notCompared` rather than as a clean result.
`pnpm-lock.yaml` and the binary `bun.lockb` are named in `notes` instead of
being read.

Each tool's description repeats the limit that matters to it. A tool that
overstates its coverage is worse than one that is narrow and says so.

## Containment, arguments, bounds

- **Containment.** Every caller-supplied path goes through `src/paths.ts`
  `resolveSafe` and is refused if it leaves the workspace root — including via
  a symlink inside the tree that points outside it.
- **Arguments.** Nothing reaches a shell; argv is always an array. That stops
  a caller reaching `sh`, not a program's own option parser, so every caller
  value that lands in argv as a bare word is refused when it begins with `-`,
  placed after a `--` terminator, or joined to its flag with `=`. A test filter
  of `-D` is refused rather than handed to a runner as an option.
- **Which program runs.** Naming the program is itself arbitrary execution, so
  only `RunTests`, `RunBuild` and `Format` — the three tools marked
  `destructive` — take an explicit `command`. `Typecheck`, `Lint`,
  `FormatCheck` and `Diagnostics` run what `src/detect.ts` works out from the
  project's own files and nothing else. That is not a convenience: a permission
  engine allows a `readOnly` tool without asking in auto mode, and allows
  nothing else at all in plan mode, so a read-only tool that let a caller pick
  the program would be an unreviewed `sh -c` wearing a checker's badge.
- **Bounds.** Every spawn carries a deadline (SIGTERM, then SIGKILL) and reads
  its pipes through a cap, so a runner that prints a gigabyte costs a bounded
  amount of *memory*, not just bounded output. `Diagnostics` spends ONE
  `timeout` across its three steps rather than one each. Every listing has a
  limit and an explicit `truncated` flag.
- **Bounded parsing.** A regular expression cannot be interrupted once it is
  running, so the places where caller text meets a pattern are bounded up
  front: the stack and test-output parsers cap a single LINE before matching
  it (an unbounded line made frame splitting quadratic — twelve seconds for
  four thousand characters), and `AstQuery` refuses a `pattern` that repeats a
  group which itself repeats or branches (`(a+)+`, `(a|a)*`) rather than
  running it against every name in a tree.
- **No implicit downloads.** A node tool is only ever used from the project's
  own `node_modules/.bin`. `bunx`/`npx` without a local install would fetch
  from the registry, which is an outbound call these tools do not declare; a
  missing binary is a clear refusal instead.
- **Determinism.** Same inputs against the same project, same bytes. Every
  listing is sorted with plain `<` — never `localeCompare`, whose order moves
  with the machine's locale — nothing reports a duration or timestamp the
  caller did not ask for, and the `command` in a result is written relative to
  the workspace root, because a detected node tool is an absolute path into
  `node_modules/.bin` and echoing it would put one machine's home directory in
  every record.

## Layout

`src/lib/` holds the pure functions — the scanner, the diagnostic and test-output
parsers, the dependency readers, the graph — and `src/lib.test.ts` is where
their behaviour is tested, against verbatim fixtures from the real tools.
`src/run.ts` is the only place a process is spawned, `src/walk.ts` the only
place a directory is walked, and `src/detect.ts` works out which toolchain a
project uses by reading files, never by running anything. `src/index.ts` wraps
all of it as tools.

## Safety flags

| Tools | Flags |
|---|---|
| `RunTests`, `RunBuild`, `Format` | `destructive`, `scope: "external"`, `ioCapability: "process"` — the only three that take an explicit `command` |
| `Typecheck`, `Lint`, `FormatCheck`, `Diagnostics` | `readOnly`, `scope: "external"`, `ioCapability: "process"` — detected commands only |
| everything else | `readOnly`, `concurrencySafe`, `scope: "internal"`, no io capability |

`RunTests` is destructive because a test suite runs the project's own code and
may write anything at all; calling it read-only would be a lie a permission
engine would believe. `Typecheck` always passes `--noEmit` for the same reason
in reverse — that is what lets it stay a read, and it is also why it takes no
`command`: a read-only tool is auto-allowed, so it must not be able to spawn a
program a caller chose. No tool here requires a justification, because none has
an outward side effect: nothing is posted, pushed or sent. `src/index.test.ts`
asserts all of this per tool — including that the read-only checkers advertise
no `command` field, and that one smuggled past the schema still never becomes a
process — so a future addition that forgets a flag fails the suite rather than
the review.
