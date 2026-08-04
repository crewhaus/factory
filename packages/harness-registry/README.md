# @crewhaus/harness-registry

The machine-wide harness registry — one JSON document
(`<registryRoot>/harnesses.json`, format `v: 2`) listing every harness
registered on this machine, plus user-configured scan roots and group
definitions. This is the registry-file layer behind the harness manager and
its CLI twins.

Pure registry-file layer by design: it never parses specs (callers supply
`specName`/`target`) and never scans the filesystem for harnesses
(discovery is the inventory layer's job).

## Roots and switches

- Registry root: the directory containing `harnesses.json` —
  `CREWHAUS_REGISTRY_ROOT`, default `~/.crewhaus`. An explicit `root`
  option wins over the env var.
- `CREWHAUS_NO_REGISTRY=1` — global opt-out: every write becomes a no-op
  while reads keep working.

## Document shape (v2)

`harnesses[]` entries carry a stable crypto-random id (`hrn_` + 16
lowercase hex, minted on first registration), the absolute `dir` (THE
upsert identity key), `specName`/`target`, provenance
(`origin: scan | manual | run-hook | import` + `originDetail`), ISO
`registeredAt`/`lastSeen`, user-managed `groups`/`tags`/`pinned`/`notes`,
`kind: local | remote`, a `watchme: { share }` compat block, opaque
`remotes[]` deployment pointers, and `missingSince`. Top-level `scanRoots[]`
(`dir`, `depth`, `auto`, `rescanIntervalMin`, `lastScanAt`) and `groups[]`
(`name`, `order`, `color`) ride along.

The format is **additive**: unknown fields anywhere in the document are
tolerated on read and preserved on rewrite, so older and newer CLIs can
share one file. Documents with `v < 2` (or none — the legacy watchme
registry format) are lifted best-effort on read and healed on the next
write.

## Write discipline

Atomic tmp+rename with per-writer-unique tmp names, file mode `0600`,
directory mode `0700`, and read-merge-write with a small
fingerprint-checked retry loop so two same-machine writers do not lose each
other's rows. Vanished directories are **never silently pruned**: `list()`
stamps `missingSince` (and clears it when the dir is back); only an
explicit `remove()` deletes a row. `list()`'s stamp/lift persists are
best-effort — on an unwritable registry root it warns and returns the
computed view un-persisted rather than failing the read.

## API

`openHangarRegistry({ root?, watchmeRoot?, now?, env?, onWarn? })` returns
`{ path, disabled, list, get, upsert, remove, relocate, setGroups, setTags,
setPinned, setNotes, listGroups, addGroup, updateGroup, removeGroup,
reorderGroups, listScanRoots, addScanRoot, updateScanRoot, removeScanRoot,
registerHook, seedFromWatchme }`.

- `upsert` is keyed by absolute dir: new entries mint an id; refreshes keep
  `id`/`registeredAt`/`origin` and the user-managed fields
  (groups/tags/pinned/notes are **never clobbered** by a refresh), update
  `lastSeen` plus any descriptive fields provided, and clear `missingSince`.
- `relocate(id, newDir)` points an entry at a new directory under the same
  id (it throws if `newDir` already belongs to another entry).
- `registerHook({ dir, specName?, target?, originDetail })` — and the
  module-level `registerHarnessHook(fields, opts?)` — is the best-effort
  self-registration entry point for CLI hooks: it never throws (any failure
  collapses into `{ ok: false }`, because a registry write must never fail
  the command that triggered it) and respects `CREWHAUS_NO_REGISTRY`.

## watchme interop

Watchme membership means **explicitly watched** — only the watchme verbs
(`watchme start`, `watchme stop --forget`) enroll or un-enroll a harness.
Interop goes through `@crewhaus/watchme-store`'s own API (never by touching
its file format):

- `seedFromWatchme()` merges the watchme registry in once (idempotent —
  safe to call every boot; already-registered dirs are left untouched).
  Imported entries get `origin: "import"` / `originDetail: "watchme"`.
- `upsert`/`relocate` mirror **freshness only** onto a watchme row that
  already exists (dir/specName/target); they never create a watchme row,
  never delete one, and never touch `share` or `agentId`. `remove()` does
  not touch the watchme registry at all. A mirror failure never fails the
  primary write (it is reported via `onWarn`, silent by default).
