# @crewhaus/run-inspect

Explains a run from its records: what started it, what each model call was given, which rules were
in force, which checks ran and what became of them, and what happened as a result. It joins records
that each store keeps apart, and it names what is missing instead of dropping it.

The design is in [module brief 332](https://github.com/crewhaus/docs/blob/main/module-briefs/332-run-inspect.md)
([#518](https://github.com/crewhaus/factory/issues/518)). The first consumer is `crewhaus runs inspect`.

It is pure folds and one bounded reader. It never calls a model, never spawns a process, writes
nothing and masks nothing: a head masks at its own exit, and prints through `terminalSafe`. Its
non-test sources import no `node:child_process`, model adapter, runtime or server, and use no Bun-only
API; `purity.test.ts` holds that.

## Reading a run

`loadRun({harnessDir, ref, run?, envVars, now, maxBytes?})` answers a `LoadedRun` or a refusal
(`invalid`, `not_found`, `unsupported`, each with the verb that helps).

- `ref` is a canonical run id or a session id. A run id finds its rows in the run ledger, which give
  its session and `sessionAt`, the session log's length when the run started; reading starts there. A
  session id reads the whole log and lists its runs; `run` picks one, else the newest run that no other
  run of the session started (a helper's run is listed as a child, never chosen by default).
- `envVars` are the harness's env-file variables. They say where the session root is, through
  session-store's `containedSessionRoot`; a root that lies outside the harness is refused.
- The session log is read only when it resolves inside that root, is not itself a link and is a
  regular file, at most `maxBytes` (32 MiB by default). Every complete line gets the id
  `s:<byte offset>`; a damaged line is a `torn` gap and reading goes on; a limit is a `truncated` gap.
- An operator's wake is written to the session log just before the run starts, so it sits below
  `sessionAt`. For a run whose stamp says a wake started it, and only then, the reader also looks back
  from `sessionAt`, at most 64 KiB, stopping at the previous `run_stamp`, and keeps only wake markers.
- The decision log is read through session-store's `readDecisionLog`, never by path; its lines get the
  id `d:<segment>:<offset>`.

`loadedRunFromText(text, {now, session?, run?, rows?, decisions?})` builds the same thing from any
session-log-shaped JSONL, an eval sample's `transcript.jsonl` for one.

## The views

| Fold | What it answers |
|---|---|
| `foldSummary` | the status in a word, what started the run, what was asked, a fixed template of what happened, the outcome, cost, duration, revisions, parent, continued and child runs, the execution whose trace events hold more, and what is missing |
| `foldTimeline` | entries newest first, key events or everything recorded, paged with `limit` (50, at most 500) and `before`; a tool call and its result are one entry; an approval's later outcome is an entry of its own |
| `foldSpanTree` | the run's spans nested, with status, duration and cost |
| `foldWhy` | for `tool:`, `answer:`, `model:` or `turn:` and a span id: what started it, what it used, the rules in force, what it did and the words it wrote before, the other options it had, every check, and the result with any later correction |
| `foldContext` | per model call, or `"all"`: the regions by kind and size, project files, recalled items, tools offered beside those in the spec, the model and its settings, and the message count |

Every field says how it is known: `recorded`, `reconstructed` by a named rule
(`legacy-turn-by-user-message`, `synthetic-marker-by-position`, `status-from-session-log`,
`records-off-by-run-row`, `span-by-position`, `zero-cost-with-tokens`), or `not-recorded` with the
gap that says why. Field names never end in `key`, `token`, `secret` or `password`, so a masker that
redacts by key name hides none of them; `views.test.ts` walks every view.

## Rules the folds keep

- **A line is the run's by its `run` stamp.** An unscoped line is never the run's, except an operator's
  wake marker and the two reconstructions that say so. With run records off, the run's lines are those
  between its row's `sessionAt` and the next run's. A session written before run records is one run.
- **Checks join by span, then by the call's ordinal**, never by the provider's tool id alone, which can
  repeat within a run.
- **An approval's later outcome joins by the approval id** the verdict names (the decision log's
  `decision`), in the same session, and by run when the line names one: the first decision, then the
  newest expire or supersede. Never by the action digest, which a moved call's superseded approval and
  its replacement share. No approval id, or no matching line: the session log's outcome only.
- **An operator's wake** reads its reason and author from the marker, the last unscoped synthetic
  message of the stamp's lane before the stamp with no other stamp between them, never from the stamp.
  No marker: "operator wake (reason not recorded)".
- **A compaction's duration** is shown only for the reactive one, whose span measures the work.
- **A span whose parent is not the run's** sits under the run, marked `orphan`; a span nothing closes is
  `unfinished`.
- **Cost** sums per-call lines and helpers' roll-ups, never the run total without a role. A line marked
  unpriced, or one that reports tokens and costs nothing without saying whether it was priced, makes the
  total "Cost unknown": never `$0`.
- **Thinking is never read.** Only text blocks of a message are.

## Missing evidence

`INSPECT_GAP_REASONS` is closed: `before-0.9`, `records-off`, `advisor-off`, `cost-off`,
`not-supervised`, `pruned`, `evicted`, `truncated`, `torn`, `unfinished`, `diverged`, `no-access`,
`unsupported`, `not-recorded`. These folds produce all but the three in `GAPS_PRODUCED_ELSEWHERE`
(`pruned`, `diverged`, `no-access`), which come with the supervisor's records and the serving layer's
viewer rights. Each gap carries `{reason, from?, to?, count?, remedy?}`; `GAP_WORDS` has a line for each.

## Not here yet

The API request and raw views, execution events, exports, work items and the inspect projection come
with the inspector over `crewhaus.hangar.v1`. Proof bundles and audit records are not read: a proof
check shows the outcome and bundle hash its verdict line carries, and an audit record only its kind.
