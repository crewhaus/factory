# @crewhaus/tool-specops

Changing a harness spec safely, as deterministic tools — so a manager harness
can maintain the specs it supervises without spending a model turn on
questions that have right answers.

Which edits may be applied to this spec, and why is the rest refused? What
does the release this harness just upgraded to expect its author to know? What
do the harness's own logs say to change? Which of `doctor`'s findings have a
mechanical repair, and what exactly would it write?

```yaml
tools:
  - specPatchApply
  - specAdvise
  - specUpgrade
  - doctorFix
```

| Tool | What it does |
|---|---|
| `SpecPatchApply` | Applies structured patches as a comment-preserving CST edit, refusing any path the optimizer allow-list does not admit and naming the reason per path |
| `SpecAdvise` | Mines the harness's session logs with the shipped advice rules: ranked findings with their evidence, and a pre-validated patch where one exists |
| `SpecUpgrade` | The post-release upgrade notes whose detectors actually fire for this spec, and whether an unacknowledged one is blocking |
| `DoctorFix` | The mechanical repairs `doctor` only prints — scaffold a spec, create the state dir, mark a tool `scope: external`, stub missing credentials commented-out |

## Thin on purpose

The CST edit, the `OPTIMIZABLE_PATHS` allow-list, the advice rules, the
upgrade-note detectors and the four doctor fixers are not here. They live in
`@crewhaus/spec-patch`, `@crewhaus/harness-advice` and
`@crewhaus/spec-changelog`, lifted out of `apps/cli` so a tool could reach
them, and this package consumes them. A rule re-derived here would be the
second implementation that refactor existed to prevent, and it would drift.

What a tool adds is the part a library cannot: the schema a model is handed,
the validation and refusals in front of it, the containment boundary around
every path, and a result shape that can say *I could not tell* instead of
guessing.

## The two gates, which are not the same gate

`SpecPatchApply` enforces the optimizer surface. A path outside
`OPTIMIZABLE_PATHS` is refused, and the refusal carries the §10.3 reason that
path is human-owned plus the admissible paths nearby — because a bare
rejection sends an autonomous caller into a retry loop:

```json
{
  "path": "agent.model",
  "reason": "path agent.model is not listed in OPTIMIZABLE_PATHS for target \"cli\"",
  "humanOwned": "the model roster is human-owned (the standing agent.model exclusion)",
  "admissibleNearby": ["agent.instructions", "agent.max_tokens", "agent.model_pool.policy", "..."]
}
```

`DoctorFix` deliberately does not go through that allow-list. Its one spec
edit — `tool_config.<tool>.scope: "external"` — is a path the allow-list does
not admit and must never admit; it is gated instead by being a closed set of
four fixers whose write to the spec is re-validated through `parseSpec`. Two
gates, two threat models, neither a way around the other. A test asserts both
halves, so widening either one fails CI.

That re-validation is enforced on the DOCUMENT, after the fixers have run
against the overlay and before anything is committed — not inside each fixer.
`planScopeFix` re-parses on its own (inside `applySpecPatch`), but
`planScaffoldSpec` writes raw text, so a `specName` YAML does not read as a
string (`2026`, `true`, `1.5`, and above all the default, which is the
working directory's basename) scaffolded a `crewhaus.yaml` that does not
parse. Charset validation cannot catch that — the name is fine, the document
is not — so the document is what gets checked.

## The advisor and the applier are checked against each other

A finding that emits a patch `SpecPatchApply` would refuse is worse than no
finding: it costs a round trip to learn nothing. The advice package
pre-validates through `patchOrAdvice`, so the symptom of disagreement is not a
refusal but *silence* — the finding quietly arrives as advice text.

`src/advice-patch-contract.test.ts` drives every patch-proposing rule to fire,
asserts the suggestion really is a patch, and applies it through the real
tool. Then it SCANS `advise-rules.ts` for every patch site, asserts the hit
count first — a scanning guard that matches nothing must fail, not pass — and
checks each scanned path against the allow-list. A rule added upstream with an
unlisted path fails here.

That test also pins one asymmetry it found: `agent.max_tokens` and
`compaction.curate` are admitted for the `cli` target only, although the
schema carries both on other shapes and the rules propose them on every shape.
On a channel harness those two findings arrive as advice, not as a patch. That
is the allow-list's call to make; the test is there so widening it is a
decision someone takes rather than discovers.

## A dry run that is the real run

Both writing tools default to `dryRun: true`, and neither builds its preview
separately.

`SpecPatchApply` applies the whole batch to an in-memory document —
re-validated through `parseSpec` after every patch — and returns that text. A
write is the same text, written. `DoctorFix` runs the real fixers against an
overlay filesystem that reads from disk and captures writes in memory; a dry
run reports those bytes, and `dryRun: false` commits those same bytes. The
tests assert byte identity between the two, because a preview rendered by a
parallel code path is how `tool-hostfs` once predicted a destination the real
call never used.

The overlay pays a second dividend: a batch of fixes reads through it, so a
scope fix patches the spec the scaffold just wrote instead of a file that is
not on disk yet.

## Could not determine is not no

Every read that can fail returns *why*, and every tool that carries on anyway
puts the reason in its result:

- `SpecAdvise` returns `complete: false` with an `incomplete` list naming a
  missing sessions directory, a log it could not read, lines that were not
  JSON, and a spec that was given but did not parse. Zero findings from an
  empty read is the one answer worth nothing.
- A directory read carries three separate answers, never one field holding
  two: `unavailable` (it was not there, or could not be listed), `truncated`
  (it was there and the pass stopped early at `maxFiles` / `maxTotalBytes`),
  and neither (a complete read, possibly of nothing). The audit directory is
  optional, so its ABSENCE does not count against `complete` unless the caller
  named it — but a partial read of one that exists always does, whoever named
  it, and so do its malformed lines. `auditRecords` is a count of records that
  were read, and anything standing between it and the whole directory is in
  `incomplete`.
- `SpecAdvise` also reports `routingScoreboard: { read: false, reason }`. The
  reward scoreboard lives in `@crewhaus/routing-store`, which this package
  does not depend on, so the three pool rules did not run — their silence is
  not evidence that routing is healthy.
- `SpecUpgrade` reports `schemaMigration: { determined: false, reason }`. It
  does not run the schema migration chain (that is `@crewhaus/migration-engine`,
  also not a dependency), and it refuses a spec no detector could read rather
  than reporting "no notes apply", which is what the note collector would have
  said for a file it could not read. There are *two* such specs: unparseable
  YAML, and well-formed YAML whose top level is not a mapping — a sequence, a
  scalar, an empty file. The second is the sharp one, because it is valid YAML
  and the detectors give up silently at their `parseSpecObject`. A
  schema-invalid *mapping* is still checked, since a spec written against an
  older schema is the main reason to ask for notes at all.
- Its note gate is called `notesCleared`, not `ready`. A boolean named `ready`
  sitting next to `schemaMigration.determined: false` would be read as the
  go-ahead for an unattended upgrade, which this package cannot give: it has
  one half of that answer.

## Refusals

- Every caller-supplied path goes through `resolveSafe` — the copy from
  `@crewhaus/tool-pkg`, unchanged — which refuses anything resolving outside
  `process.cwd()`, including through a symlink inside the workspace. Paths the
  fixers compose go through it too, and destinations are re-resolved at commit
  time rather than trusted from planning time.
- An env var name is parsed to `^[A-Z_][A-Z0-9_]*$` before it is written,
  because the fixer writes `# ${name}=` verbatim and a name carrying a newline
  would append an uncommented line to the operator's `.env`. There is no field
  anywhere in these schemas to pass a credential VALUE.
- A scaffolded spec's name is parsed the same way, for the same reason: it is
  interpolated into the YAML. The charset check is the injection floor and not
  the whole gate — the scaffolded document is re-parsed before it is written,
  which is what catches a name YAML types as a number or a boolean.
- `op: "remove"` is judged by the same rule a `replace` is. `validatePatch`'s
  block guard asks what a patch's VALUE would change, so it has nothing to say
  about a removal, and removing the `model_pool.learning` block used to delete
  the `seed` a routed eval pins — the edit that is refused when it is spelled
  as a replace. The tool asks the removal question against the same exported
  `OPTIMIZER_REFUSED_LEAVES` table, and only when the document actually carries
  the leaf.
- A tool name that is not a plain identifier, or any `mcp__*` dynamic sink,
  stays advisory — those are definitionally external and need a human's
  vetting, not a mechanical stamp.
- Refused paths are echoed back truncated and stripped of control characters,
  and no refusal splices in a node error, which would carry an absolute path
  the caller never supplied.

## What these tools do not do

They never run a harness, never reach a provider, and never register a spec
version in the registry — `SpecPatchApply` writes the file and stops, so the
only side effect is the one the caller asked for. They read a spec's declared
configuration, which is not always the configuration a running harness has.
And a spec that passes here is a spec that is *valid*, which is not the same
as a spec that does what its author meant.
