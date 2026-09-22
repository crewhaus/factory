# @crewhaus/tool-lifecycle

The back half of a harness's life, as deterministic tools: retirement, store
migration, retention enforcement and knowledge sync.

These four are the operations that are irreversible when they are wrong. A
retirement moves a harness's durable state out and removes the live copy. A
retention sweep deletes sessions on an age rule. A store migration writes one
store's contents into another root. A knowledge push copies a harness's
memories into a store other harnesses read. None of them can be undone by
running them again with a better flag — so all four default to a dry run, and
all four refuse a selection wider than the caller plainly meant.

```yaml
tools:
  - harnessRetire
  - storeMigrate
  - retentionEnforce
  - knowledgeSync
```

| Tool | What it does |
|---|---|
| `HarnessRetire` | Fingerprint a harness's `.crewhaus`, archive it, remove the live copy, and verify the archive against the fingerprint |
| `StoreMigrate` | Copy a harness's sessions and audit files into another store root, verify every byte, and write a receipt |
| `RetentionEnforce` | Run the TTL sweep or an explicit purge under `.crewhaus/retention.json`, and evidence it in the audit chain |
| `KnowledgeSync` | Push a harness's memories and fragments to a shared store, or pull the store's into the harness |

## The real library, not a second implementation

Every rule these tools enforce belongs to `@crewhaus/harness-lifecycle`, which
is where `apps/cli` kept it before a tool could reach it:

| Rule | Where it lives |
|---|---|
| Retirement plan, step order, active-pin refusal, abort-before-destruction, `retirement.json` | `buildRetirementPlan` / `runRetirement` |
| Age rule, pins, audit windows, the audit-chain deletion exclusion, the evidence record | `runRetentionSweep` / `runRetentionPurge` |
| Store enumeration and the verbatim copy | `openHarnessRecordStore` / `runRetentionExport` |
| Shared-record validation (including the re-hash that defeats dedupe poisoning) | `validateSharedMemory` / `readSharedFragments` |
| Credential masking and the drop-if-still-secret verdict | `buildKnowledgeRedactor` |
| Push/pull planning and application | `planPush` / `applyPush` / `planPull` / `applyPull` |

This package contributes the schema, the containment, the refusals and the
result shape. It contains no second copy of any of those rules — the whole
point of lifting them out of the CLI was that a second copy drifts.

## Four properties

**Dry run is the default, and it is the same code.** `dryRun` defaults to
`true` everywhere here; acting takes an explicit `dryRun: false`. The preview
is produced by calling the same library function with its own dry-run flag, so
the selection being previewed is the selection the real call acts on. Where the
two can still disagree — the library re-enumerates, and a store can change
between the calls — the difference is computed and reported as
`divergedFromPreview` instead of being hidden. `RetentionEnforce` reads the
clock once and hands the same instant to both passes, so at least the age rule
cannot move underneath them.

**Could not determine is not no.** A directory that could not be listed is
never reported as empty. An unreadable registry manifest is never reported as
"no pins" — that is the one that retires a harness an environment is still
pointed at. An archive that could not be located is never reported as verified.
A step this build did not perform reports that it did not perform it, rather
than returning success.

**Containment.** Every caller-supplied path goes through `resolveSafe` (copied
verbatim from `@crewhaus/tool-pkg`), which refuses anything resolving outside
`process.cwd()`, including through a symlink inside the workspace. A path
carrying a NUL is refused before any syscall sees it, because a NUL truncates a
path at the syscall boundary and the check would then be looking at a different
path from the `open`.

Containing the *directory* is not enough, so every path these tools actually
write to — or delete through — goes through the same check: `<dest>/sessions/<id>.json`,
`<shared>/memories.jsonl`, `<harness>/.crewhaus/prompts/…`, `.crewhaus/sessions`
itself. A symlink at one of those names sends the write, or the unlink, to the
link's target, and a *dangling* one does not even look like a conflict — `stat`
calls it absent while `open(…, "w")` through it creates the target. There is no
flag past this: `overwrite` replaces files, it is not consent to leave the
workspace.

Flags are parsed first and acted on as the parsed value:
a `before` or `since` becomes epoch ms via the library's own
`parseRetentionDate`, and the result echoes the timestamp that was actually
used, never the caller's string as though it were the cutoff.

**Verification, not optimism.** `HarnessRetire` fingerprints every file under
`.crewhaus` with sha256 before the move and re-hashes the archived tree
afterwards. `StoreMigrate` hashes each source file before the copy (after,
the library has already appended its own evidence record to the source) and
re-hashes the destination. Both report per-file mismatches, and both report an
entry they could not hash as *unverifiable* rather than counting it as
verified.

## What each tool refuses

**`HarnessRetire`**

- an environment still pinned to a registered version (the library's own rule);
- a registry manifest that cannot be read or parsed — refused as `unreadable`,
  never read as "unpinned";
- a registry entry with versions this build cannot delete: the step fails, the
  library aborts before the destructive move, and the live state is untouched.
  There is deliberately no `force`: forcing past the pin refusal would leave
  environments pointing at state that no longer exists, and this build cannot
  tombstone them;
- an archive directory that is not empty, because `runRetirement` *replaces* an
  existing `crewhaus-state` inside it — retiring twice into one archive would
  destroy the first harness's copy (pass `overwriteArchive` if that is really
  the intent);
- an archive directory overlapping the state directory it archives;
- an archive directory where the retirement log or the fingerprint manifest
  would be written through a symlink leading out of the workspace;
- a `.crewhaus` that is a *symlink*: `renameSync` moves the link, so the data
  would stay exactly where it is while the harness lost its pointer to it, and
  a verification that followed the link into the archive would pass;
- a `.crewhaus` that exists but is **not a directory** — an entry that could
  not be identified is not an absent one, and the archive step would move it
  anyway;
- a state tree over `maxStateFiles` / `maxStateBytes` (50,000 files / 512 MiB by
  default), because the fingerprint is the slow part and an unbounded one is
  not a budget;
- a real run without `acceptUnverified`, see below.

**`StoreMigrate`**

- a destination overlapping a live store (the library's own refusal);
- a destination holding a `store-migration.json` from a *different* source —
  two harnesses' stores merged into one root cannot be separated afterwards,
  and their audit chains cannot both verify;
- a destination whose previous receipt cannot be read, unless `overwrite`;
- files at the destination that would be written over, unless `overwrite` —
  counted by NAME, and counting everything the run *writes* rather than only
  what it copies: the export path drops its own `manifest.json` beside the
  copies and this tool adds `store-migration.json`, and both are in
  `wouldWrite`;
- a destination path that is a symlink leading out of the workspace, with no
  override;
- a `targetVersion` different from the source's, and any `targetVersion` at all
  against a store with no version stamp. See below.

**`RetentionEnforce`**

- a selection covering *every* session in the store, unless `allowDeleteAll`
  says that is the intent;
- a selected record whose timestamp is at or before 1971 — **with no override at
  all**. A timestamp that low is a broken clock, a failed copy or a restored
  archive, and every age rule reads it as infinitely old and takes it first.
  The fix is to repair or pin the record, not to confirm a number nobody
  believes;
- a purge cutoff in the future, which means "everything older than the future";
- a selection over `maxDeletions`;
- a malformed `.crewhaus/retention.json` — the library throws rather than
  falling back to a default, and the tool surfaces that: an enforcer that half
  understands its policy must not guess;
- a store that cannot be enumerated;
- a `.crewhaus/sessions` or `.crewhaus/audit` that is a symlink leading out of
  the workspace. `readdir` follows it and session-store unlinks inside the
  target, so a sweep of a harness in the workspace would delete files that were
  never in it. `allowDeleteAll` does not reach this.

**`KnowledgeSync`**

- a push from a harness that has not opted in (`.crewhaus/knowledge.json`);
- a push without `allowWithoutPiiRedaction`, see below;
- a shared store overlapping the harness's `.crewhaus`, which would re-ingest
  its own pushes;
- a sync moving more than `maxArtifacts` (500 by default) — a poisoned shared
  store is untrusted input, and so is a runaway push;
- a push or a pull whose write path leaves the workspace through a symlink. The
  shared store is untrusted by this tool's own description, so a link planted at
  `memories.jsonl` would otherwise have appended the harness's memories to
  whatever it pointed at.

## What this build does not do

Three things the CLI does around these operations need packages
`@crewhaus/tool-lifecycle` does not depend on. Each is named where it would
have happened, and the operations that depend on it refuse rather than
approximate.

**Audit-chain verification and the compliance-evidence bundle.**
`@crewhaus/audit-log` and `@crewhaus/compliance-controls` are not dependencies
here, so `HarnessRetire` supplies those two steps as `ok: false` with the
reason. The library's own gate then aborts the retirement, which is the correct
default: nothing should be moved on the strength of a chain nobody checked. Run
the `AuditVerify` tool (`@crewhaus/tool-crewhaus`) first, then pass
`acceptUnverified: true`. The tool never claims either check happened — a real
run reports both under `notPerformed`.

**Record-shape store migration.** `StoreMigrate` moves a store between roots at
the version it already has. Rewriting records into a new shape is
`migrateMemories` in `apps/cli`, over `@crewhaus/memory-store` and
`@crewhaus/migration-engine`; a package may not depend on an app, and those two
are not dependencies here. A version-changing migration is therefore refused by
name rather than silently performed as a copy, which would leave a caller
believing their store had been upgraded.

**PII redaction on push.** Production wires the knowledge redactor around
`@crewhaus/pii-redactor`. Without it this build runs the credential half —
masking, plus the strict post-mask rescan that *drops* an artifact still
looking like a secret — with an identity PII pass. Names, emails and phone
numbers are not removed. A push says so and requires
`allowWithoutPiiRedaction`. (The library's `IDENTITY_REDACTOR` is deliberately
not used: it never flags anything, so a memory holding an API key would be
pushed verbatim.)

**What a store migration leaves behind.** `runRetentionExport` carries
`.crewhaus/sessions` and `.crewhaus/audit`. Memories, prompts, graders, the
registry and the policy files are not part of it, so every other entry under
`.crewhaus` is listed in `notMigrated` — a migration that reports success while
leaving them behind is exactly the half-migration that puts a store in neither
shape. The source is never deleted, so it remains the rollback, and a re-run is
safe: the receipt says what was already there.

## Two things this package does differently from the CLI

**Dropped secrets are counted, never echoed.** `formatPushReport` prints a
60-character preview of every memory dropped for still carrying a credential —
those previews are the secret. This tool reports `droppedForSecrets` as a count
only. A test asserts the raw result string does not contain the fixture secret.

**A pulled memory is recognised on the next pull.** `applyPull` lands a memory
with an extra `shared:<harness>` tag, and the content hash covers text *and*
tags — so hashing what is on disk does not reproduce the shared record's hash.
`crewhaus knowledge pull` compares exactly that way, which means every pull
re-imports everything it pulled before and `shared.jsonl` grows on each run.
`KnowledgeSync` hashes a landed memory both ways (still with the library's
`memoryContentHash`), so a second pull brings in nothing. The undo is exactly
`applyPull`'s do: **one** trailing `shared:` tag comes back off, because one
went on. Stripping every `shared:`-prefixed tag is a different function, and it
is wrong for the record that already carried provenance of its own — one
harness pulled it and pushed it on — for which neither form reproduces the
shared hash. `index.test.ts` pins both: the plain case still holds one line
after two pulls, and the round-tripped record is neither reported missing after
the pull that landed it nor re-imported by the next one.

**A pulled grader fragment is recognised too.** `applyPull` writes one to
`graders.shared-<hash>.yaml`, which `readHarnessGraders` deliberately does not
look at — it reads the harness's *own* `graders.yaml`. Fragments a previous
pull landed are counted separately (matched by that landing name, hashed with
the library's `fragmentContentHash`), so a second pull does not report pulling
them again. Fragments are also verified after a pull, as a push verifies its
own: checking only the memories and calling the whole pull `verified` would be
a partial check reported as a total one.

## Results

Every tool returns compact JSON with a `status` of `preview`, `applied`,
`refused` or `failed`, plus a `code` and a `reason` on the two unhappy ones. A
preview carries `nothingWasTouched: true`. Sizeable lists are reported as
`{ shown, total }` so a bounded result never implies a short one.

## Limits

- **The opt-in marker gates a push, not a pull.** `crewhaus knowledge sync`
  filters a whole fleet by `.crewhaus/knowledge.json` in both directions,
  because it walks harnesses nobody named. A tool call names one directory, and
  the risk there runs the other way — what leaves the harness — so the marker
  is required to push and not to pull. A pulled record is still validated by
  the library and counted if it is refused.
- **Single tenant.** The on-disk stores carry no tenant id, so everything here
  operates on the local tenant, exactly as `@crewhaus/harness-lifecycle` does.
- **The archived-state directory name is mirrored, not imported.** The library
  moves the live state to `<archive>/crewhaus-state` and does not export that
  name. If it ever changes, `HarnessRetire` reports that it could not verify
  the archive (it never reports a verified one it did not find), and a test
  here fails on the rename.
- **A retirement cannot be resumed.** The library aborts before the destructive
  step, so a failed retirement leaves the harness intact and is re-runnable,
  but there is no half-state to pick up from — by design.
- **Verification is of bytes, not of meaning.** A verified archive is one whose
  files hash the same as before the move. Whether the harness should have been
  retired at all is not a question a hash can answer.
