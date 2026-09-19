# @crewhaus/tool-fleet

The harnesses on this machine, as deterministic tools: register them, ask what the job queue
did, recompile a stale bundle, see which CLI version each one is really running, and manage the
hooks that wrap a start.

| Tool | Does | Consumes |
|---|---|---|
| `HarnessRegister` | add / remove / relocate / list / annotate registry rows | `@crewhaus/harness-registry` (`openHangarRegistry`) |
| `HarnessJobStatus` | read the manager's durable job ledger | `@crewhaus/harness-supervisor` (`createFileJobStore`) |
| `CompileBundle` | judge a bundle against its spec and recompile a stale one | `harness-supervisor` (`bundleStaleness`, `compileIfStale`) |
| `CliVersionPin` | which CLI each harness would run, which one built its bundle | `harness-supervisor` (`resolveCrewhausBin`, the bundle stamp) |
| `HooksManage` | list / set / remove the manager hooks in `.crewhaus/settings.json` | `harness-supervisor` (`parseManagerHook`, `readManagerSettings`) |

## These tools are thin on purpose

Everything they enforce belongs to a package they depend on. The registry file is written by
`@crewhaus/harness-registry` and by nothing here — its atomic tmp+rename, its `0600` mode and its
fingerprint-checked read-merge-write retry are what stop two sessions and a running manager from
losing each other's rows, and a read-modify-write of `harnesses.json` in this package would defeat
all three. Bundle staleness is the supervisor's spec-hash comparison, the recompile is its
`compileIfStale`, the hook grammar is its `parseManagerHook`, the job fold is its
`createFileJobStore`. This package contributes the schema, the containment, the refusals, the
verification after the fact and the result shape.

## An empty store and an unreadable one are different answers

Every store behind these tools answers a file it could not open with an empty result:

```js
try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { parsed = undefined; }  // harness-registry
try { text = readFileSync(path, "utf8"); } catch { return []; }                          // job store
const manager = readManagerBlock(dir); if (manager === undefined) return EMPTY;          // manager settings
```

Each is right where it lives — all three are read on a boot path that must not die on a typo —
and each is a lie in a report. So every tool here probes the file's CONDITION before concluding
anything from an empty result, and says which of the two it got:

- `HarnessRegister list` on an unparseable registry returns `status: "unreadable"`, never
  `status: "ok", count: 0`.
- `HarnessJobStatus` refuses a ledger it cannot open instead of reporting an idle queue, and
  distinguishes "the file is there and folded to no records" from "there is no file".
- `HooksManage list` on a settings file that does not parse says the hooks shown are the reader's
  DEFAULTS, not the file's contents.
- A mutation against a registry or a settings file that exists and did not parse is **refused**:
  the next write would heal it wholesale, taking every row, group, tag, note — or the runtime's
  own `hooks` and `permissions` blocks — with it.
- `CREWHAUS_NO_REGISTRY=1` turns registry writes into silent no-ops while the API still returns a
  perfectly plausible entry. Mutations refuse rather than report an entry that was never
  persisted, and `list` carries `writesDisabled`.
- `list()` can also fail to PERSIST (a root-owned `~/.crewhaus`, a read-only home) and degrades to
  an un-persisted view through an `onWarn` whose default is silence. Those warnings are captured
  and reported as `registryWarnings`.

## A bundle that could not be judged is not a fresh bundle

`bundleStaleness` has six states. `compileIfStale` recompiles on `stale` and `approximate-stale`;
for `unstamped` and `unknown` it returns `{ ok: true, replan: false }` and carries on. Reporting
that as success is how ten of eleven harnesses sat on last month's CLI with every status line
green. `CompileBundle` therefore reports three verdicts:

| library state | verdict | exact |
|---|---|---|
| `fresh` / `stale` | fresh / stale | yes — spec-hash stamped |
| `approximate-fresh` / `approximate-stale` | fresh / stale | no — mtimes only |
| `unstamped` / `unknown` | **undetermined** | no |

A real run on an undetermined verdict is refused, with the command that fixes it. The mapping is a
`switch` with a `never` default, so a seventh state added upstream is a build error here instead of
landing silently in "fresh".

After a real compile the freshness is **re-read from disk**: an exit code of 0 says the command
succeeded, only the stamp says the bundle now matches the spec. A compile that exited 0 and left
the bundle stale is reported as `incomplete`, with `stillNotFresh`.

`BundleFreshness` in `@crewhaus/tool-crewhaus` answers a different question — preflight's mtime
heuristic. When the two disagree, the stamp is the one the manager acts on.

## The identity key is the id, not the path

A relocate changes the directory and keeps the `hrn_` id, which inverts the key every other call
uses. So:

- an `id` input is validated against `HARNESS_ID_RE` first, because the registry silently treats
  any other string as a DIRECTORY and resolves it against the working directory;
- `remove` and `relocate` resolve the ENTRY first and then act on `entry.id`, so the preview and
  the real call select the same row;
- after a relocate the registry is re-read and the result carries `entriesWithId` and
  `entriesLeftAtOldDir` — a registry keyed by path answers a relocate by adding a second row, and
  the count is the only thing that catches it;
- a directory reached through a symlink is registered under its REAL path, and a register that
  finds an existing row under either spelling refreshes that row instead of adding a second.

## Containment, and the one named exception

Every path a caller supplies goes through `resolveSafe` — the verbatim `@crewhaus/tool-pkg` copy —
and so does **every leaf underneath it that these tools actually open**, not just the directory the
caller named. Containing a directory and not its leaves contains nothing: none of the four files
below is named in any schema, each is handed back by a library that resolves it with `existsSync`
(which FOLLOWS a symlink), and each is opened.

| leaf | found by | what a symlink out of the workspace would do |
|---|---|---|
| `crewhaus.yaml` / `.yml` | `findSpecPath` | another harness's spec parses and its `name`/`target` come back as this one's — and `HarnessRegister` writes them into the machine-wide registry |
| `dist`/`build`/`.` + its entry and `package.json` | `resolveBundle` | the stamp is read from elsewhere — and `compileIfStale` runs `crewhaus compile … -o dist` and `bun install --cwd dist` with the harness as cwd, so the recompile WRITES there |
| `.crewhaus/settings.json` | `readManagerSettings` | another file's hooks are reported as this harness's, and the atomic rewrite ends in a rename that replaces the link's target |
| `.crewhaus/run/hooks.json` | `readHookRunLog` | another harness's hook history is reported as this one's |

Each is refused, with the reason, and there is no flag to follow the link. `CompileBundle`'s gate
runs BEFORE the `dryRun` branch, so the preview and the real call refuse identically. The check is
the same `resolveSafe` the root went through, never a second symlink walker — and it resolves a
DANGLING link by hand, because `stat` reports one absent while an `open(…, "w")` through it creates
the target. `HooksManage` additionally contains the temp file its atomic replace renames from: that
name is one this tool creates and nothing else checks.

Paths a STORE hands back are contained too: `CliVersionPin` re-contains every registry row before
opening a spec or a bundle under it and reports the rest as skipped, and rows are deduped by real
path so one harness cannot be counted twice in the version roll-up.

The exception is deliberate and no input can move it. The two machine-wide files —
`<registryRoot>/harnesses.json` and `<hangarRoot>/jobs.jsonl` — are resolved from the environment
(`CREWHAUS_REGISTRY_ROOT`, `CREWHAUS_HANGAR_ROOT`), because a registry that only ever saw the
current workspace would not be a registry. Their absolute paths are reported in every result.

Two binaries are executed: `crewhaus compile` (by `CompileBundle`) and `<bin> --version` (by
`CliVersionPin --probe`). Both come from the supervisor's own resolver — harness-local
`node_modules/.bin/crewhaus` first, then `PATH` — and a binary that resolves OUTSIDE the workspace
is refused unless `allowExternalCli` is passed, with its path named.

## What a compile is given

A minimal environment: `PATH`, `HOME`, `TMPDIR`/`TEMP`/`TMP`, `LANG`, `LC_ALL`, `SHELL`, plus any
names passed in `forwardEnv` (names only — values come from this process, and the result reports
which ones actually had one). This is deliberately NOT the harness's merged `.env` chain, which is
what the manager hands a compile: a compile reads a spec and writes a bundle, and a tool that
spawns it with the harness's provider keys makes every compile a place a credential can leak into
a log. The cost: a harness whose `bun install` needs a private-registry token has to forward it by
name.

## What this build does not do, and why

- **Install, switch or pin a CLI version.** That is `@crewhaus/chvm` talking to
  `registry.npmjs.org`. Neither the dependency nor the network call belongs here, so
  `CliVersionPin` reports `cannotDo` with the `chvm` command instead of half-doing it.
- **A FIRST compile.** `compileIfStale` only acts on a stale verdict, so a harness that has never
  been compiled (`unknown`) cannot be compiled through it. The refusal names
  `crewhaus compile <spec> -o <outDir>` rather than reimplementing the compile — that would be a
  second compile path, which is the drift this architecture exists to avoid.
- **Execute a hook.** `HooksManage` reports what a declaration parses to, where its command
  resolves and whether that file exists and is executable, and never runs it. The probe answers on
  the NAME first: `access(…, X_OK)` succeeds on a directory (the bit means "traversable" there), so
  a command that is a directory — or a dangling symlink — would otherwise be written as
  `executable` and then refuse every start of the harness with EACCES. A dry run that
  spawned an operator-supplied command would be a tool that runs arbitrary code to answer a
  question about configuration.
- **Cancel a job.** The job store is append-only and has no cancel route; `HarnessJobStatus` is
  read-only.
- **Say whether a job is terminal.** `TERMINAL_JOB_STATES` lives in
  `harness-supervisor/src/queue.ts` and is not re-exported from that package's index, and a second
  copy here could disagree with the queue. States are reported verbatim and counted by state
  instead. `interrupted` IS final — a manager that died mid-job reopens the row as interrupted and
  never re-runs it — which is why it is called out in the tool's description.

## Where this differs from the survey sketch

- **`HooksManage` manages the MANAGER hooks, not the runtime ones.** The sketch pointed it at
  `@crewhaus/hooks-engine`'s `{event, matcher, command}` entries. Those are runtime hooks that fire
  on model-driven moments; the hooks a FLEET tool is about are the `postCompile`/`preSpawn` steps
  the supervisor runs around a start, they live in the same `settings.json`, and their owner is
  already a dependency here. `hooks-engine` is also not a dependency of this package and adding one
  is a standing maintainer no.
- **No hook is executed.** The sketch had `dryRun` spawn the hook against a fixture under the
  engine's restricted env. Running an operator-supplied command to answer a question about
  configuration is a bigger thing than the question, and the restricted-env fidelity argument does
  not apply to manager hooks — they run with the harness's own merged environment by design. What
  the sketch wanted from that spawn (does this hook actually work?) is answered without it: the
  parsed argv, the resolved command, whether that file exists and is executable, and the last run
  the supervisor recorded.
- **`CliVersionPin` reports; it does not pin.** The sketch had it call chvm's install/use/list.
  That needs `@crewhaus/chvm` and `registry.npmjs.org`. The version JOIN it describes is the
  valuable half and needs neither, so that is what it does — with the tri-state it asked for, made
  explicit: a version that could not be read is `unknown` with a reason, and a bundle with no stamp
  is not counted as agreeing with anything.
- **`HarnessJobStatus` has no `wait`.** A poll loop inside a tool holds the caller's turn for a
  duration nobody declared, and its answer depends on when it happened to be called; re-calling the
  tool is the same information, on the caller's own schedule. The insight behind the sketch's
  `wait` is kept where it belongs — `interrupted` is final, and the description says so.
- **No `scan-register`.** Walking a tree for `crewhaus.yaml` is `discoverHarnesses`, which
  `HarnessInventory` in `@crewhaus/tool-crewhaus` already exposes; a second walk here would be a
  second definition of what a harness is. Feed its output to `HarnessRegister register`.
- **The registry root is not an input.** The sketch's `allowedRoots` check becomes the containment
  boundary every other path in this package already passes: a harness registered through this tool
  is inside the workspace, resolved through its symlinks, and no input can move the registry file
  itself.

## Result statuses

Every result is one JSON object carrying a `status`:

| status | means |
|---|---|
| `ok` | a listing, and the store it came from was readable |
| `preview` | `dryRun` — carries `nothingWasTouched` and what WOULD happen |
| `applied` | the change was made AND read back |
| `unchanged` | nothing needed doing (a fresh bundle, a hook that was not declared) |
| `incomplete` | the step ran and the state it should have produced is not there |
| `failed` | the step ran and did not succeed — carries its stage, exit code and output |
| `undetermined` | the question could not be answered; never a stand-in for "no" |
| `unreadable` | the store could not be read; the numbers in the result mean nothing |
| `refused` | the tool would not proceed — carries a `code` and a `reason` |

## Notes

- `HarnessJobStatus` and `CliVersionPin` declare `readOnly: true`, and nothing they do writes.
  `harness-registry`'s `list()` normally persists its own missing-directory stamps and any pending
  pre-v2 lift ON A READ, so merely reporting the fleet would edit a machine-wide file — and
  `readOnly` is a flag a permission layer acts on, not a note. Every enumerating READ here opens
  the registry through the library's own `CREWHAUS_NO_REGISTRY` switch: the computed view,
  including the freshly stamped `missingSince`, is identical and every write becomes a no-op.
  `HarnessRegister list` does the same, because its schema calls it "the only one that never
  writes". A test asserts the registry file is byte-for-byte unchanged after both.
- **A cap that stops an enumeration says so.** `CliVersionPin` inspects at most 500 harnesses; past
  that it reports `truncated: true`, `registryRows` and a note, because `mixedFleet: false`
  computed over the first 500 rows of a larger fleet is an answer about a subset that reads as an
  answer about the fleet.
- **Text these tools did not write is bounded and made printable** before it lands in a result: a
  spec's `name`, a bundle manifest's `compiledWith` (which is also a KEY in the version roll-up), a
  row another writer put in the shared registry, a job's `error`, a line a spawned binary printed.
  That is not a claim the text is trustworthy — a short printable sentence can still read like an
  instruction — only that one of them cannot spend a model's whole context or forge a line break
  out of the field it sits in.
- **A registry write that cannot land is reported, not thrown.** Every setter in
  `harness-registry` throws when its rename fails (only `list()` degrades), and an exception out of
  `execute` reaches the caller as a bare `EACCES` with no tool and no code. A multi-field `update`
  reports `applied`, `notApplied` and `failedAt`, because it is several atomic writes and a failure
  halfway through leaves some fields on disk and some not.
- `dryRun` defaults to **true** on every mutating action. The preview runs the same selection code
  as the real call: the same registry lookup, the same staleness verdict, the same parsed hook.
- A multi-field `HarnessRegister update` is several atomic writes (one per registry setter), not
  one transaction. Another writer can land between them. The alternative would be a second
  document-level write path in this package.
- The registry-condition probe and the registry's own write are two separate operations; a file
  that becomes unparseable between them is not caught. The probe closes the window that matters —
  an operator running a tool against a registry that is *already* broken.
- `HooksManage` preserves the settings file's mode when it rewrites it, and creates `.crewhaus`
  with mode `0700` when a harness has never been supervised.
