# @crewhaus/tool-deploy

Moving a spec version between environments in the **local** registry, as
deterministic tools: register-and-pin, roll back, and say what is pinned where.

Nothing here reaches a network. The whole subject is
`.crewhaus/specs/` — `@crewhaus/spec-registry`'s file-backed store — and the
three packages that own it.

```yaml
tools:
  - deployInspect
  - deployRollback
  - specPin
```

| Tool | What it does |
|---|---|
| `SpecPin` | Register a spec file's current content as a version (content-gated, so unchanged content is a no-op) and pin that version to an environment, or to a tenant's overlay of one |
| `DeployRollback` | Repoint an environment at an earlier registered version. Destructive; dry run by default |
| `DeployInspect` | Read-only: registered versions, environment pins, tenant overlays, and whether what each pin points at is still there |

## The real packages, not a second implementation

| Rule | Where it lives |
|---|---|
| Storage layout, name/version/environment grammars, the pin itself, tenant overlays | `@crewhaus/spec-registry` |
| Content hash, `vN` numbering, the idempotent put, the per-spec `CHANGELOG.md` | `@crewhaus/spec-changelog` (`autoRegisterSpecVersion`, `contentHash`, `nextVersion`, `registrySpecName`) |
| Rollback orchestration and the `DeploymentRecordPayload` | `@crewhaus/deployment-controller` |
| Path containment | `paths.ts`, a verbatim copy of `@crewhaus/tool-pkg`'s |

This package contributes the schema, the containment, the refusals and the
result shape. There is no second manifest parser, no second content hash, no
second next-version rule and no second name mapping in it. Even the grammars
are enforced by *letting the adapter reject the input* — the read that fetches
an environment's current pin is also the call that validates the environment
name — rather than by a regex here that could drift from the registry's.

## Why there is no `DeployPromote`

The catalog's `DeployPromote` carries a `protected_envs` guard: refuse unless
the call carries a justification **and** the permission rule for `toEnv`
resolved to an explicit allow. A tool cannot enforce the second half. It sees
its arguments and its `tool_config`; it never sees how the permission engine
resolved the call. With `alwaysAllow DeployPromote(*)` in place, a naive
implementation reads its own config, finds the tool permitted, and satisfies
the "explicit allow" condition with the very rule the guard exists to detect —
so the protection is decoration on the one tool whose entire purpose is to be
protected.

That is a contract question (does the tool-builder hand a resolved decision
down to `execute`?), and it is parked with the maintainer. Until it is
answered, promotion stays in `crewhaus deploy promote`, which runs where the
decision is known. `SpecPin` covers the honest half of the job: pin a known
version to a named environment, with its own conflict refusal.

## Five properties

**Containment reaches the leaves, not the directory.** Everything the registry
and the changelog write — `<root>/<name>/manifest.json`,
`<root>/<name>/<v>.yaml`, `<root>/<name>/CHANGELOG.md`,
`<root>/_tenants/<id>/<name>.json` — goes through the same symlink-aware
`resolveSafe` the root went through, before the adapter is handed anything.
All four are written with `writeFileSync`, which follows a symlink sitting at
the name; a *dangling* one is the worst case, because `stat` reports it absent
so it does not even look like a conflict, while `open(…, "w")` through it
creates the target. `DeployInspect` contains the names `listSpecs` hands back
too — that is a `readdir`, and a directory entry can be a symlink anywhere —
and it contains `_tenants/<id>/<name>.json` before its tenant view reads it. A
read is not exempt from any of this: that one path was reached with no
containment at all, and a symlink planted at it returned a file from outside
the workspace as the tenant's pinned version.

**Could not determine is not no.** A manifest that will not parse is never "no
versions". A `manifest.json` that is a dangling symlink is never an absent one:
the registry probes with `existsSync`, which follows the link and answers
`false`, so the read comes back as a clean empty manifest — the single case
where "nothing is registered here" and "there is a door here" are spelled the
same. It is probed with `lstat` instead. A registry root that could not be
listed is reported as unlisted, never as an empty registry.

**A pin is only as good as what it points at.** `registry.list()` reads the
manifest and nothing else, so `deployment-controller`'s only rollback guard —
`list(name).includes(version)` — passes for a version whose `<v>.yaml` has been
deleted. The pin is written, the returned record reads exactly like a
successful deploy, and the environment now resolves to nothing. Every version
these tools pin to is *fetched* first, and a version the manifest lists but
whose bytes are gone is refused by name. `lib.test.ts` demonstrates the gap
against the real controller.

**Parse, then act on the parsed value.** A caller names a spec the way the spec
does; the registry stores it under `registrySpecName`'s mapping. Every
containment check, refusal and result field is built on the *mapped* name, and
every result carries both (`spec`, `registryName`, and `nameWasMapped` when
they differ). The mapping is many-to-one, so acting on the caller's spelling
while the store acts on the mapped one is not cosmetic: `"a b"` and `"a-b"`
land in the same directory. A name that maps onto the constant `"spec"`
fallback — `"."`, `".."`, `"..."` — is refused rather than filed in a bucket
shared with every other unmappable name.

**Destructive means dry run by default, through the same selection code.**
`DeployRollback` takes an explicit `dryRun: false` to act, and the preview is
produced by `planRollback`, the same function the real call plans with — not a
parallel preview beside it. `SpecPin` offers `dryRun` too, and additionally
refuses to move an environment that is already pinned unless `repin: true`,
because the registry has no unpin and keeps no pin history: the binding a
repin replaces would survive nowhere afterwards except the tool's answer, which
is why that answer always carries it.

## What this build cannot do, and says

**No audit record is written.** `@crewhaus/audit-log` is not a dependency of
this package, and `@crewhaus/deployment-controller` appends its
`kind: "deployment_action"` record only when it is given an `AuditLog`. So
`SpecPin` and `DeployRollback` change the registry pin and report, next to the
change, that its audit entry was not written and why. Nothing here fabricates a
substitute: a hand-rolled JSONL beside the registry would be a second,
unchained "audit log" that disagrees with the real one, which is worse than
none. Run the change through `crewhaus deploy` when the chain matters.

**No deploy history.** The same absence, read side. An environment's history
exists only in that audit chain — the manifest keeps one version per
environment, with no record of what came before. `DeployInspect` reports
`deployHistory: { available: false, reason }` rather than omitting the field,
and `DeployRollback` refuses a relative version word (`previous`, `last`, …)
with that reason rather than treating it as a literal version name and
answering "version not in registry", which reads like a typo.

**No version diff.** A field-level diff between two registry versions is
`@crewhaus/spec-patch`'s `diffSpecYaml`, which is not a dependency either. Use
the `SpecDiff` tool. The per-spec `CHANGELOG.md` beside the manifest already
carries the diff `@crewhaus/spec-changelog` rendered at registration time.

**No optimizer provenance in the changelog.** `autoRegisterSpecVersion` accepts
an `optimizeRootDir` and enriches the changelog entry with the run's
`rationale`. It is not passed, because the path it opens is
`<optimizeRoot>/<runId>/patch.json` where `runId` is read out of a *comment in
the spec being registered* — a path this package cannot contain without
`@crewhaus/spec-patch`'s `parseWriteBackHeader` to tell it what the `runId` is.
Containing a root and not the leaf under it contains nothing, so the garnish is
left off.

**A tenant's pin can only sometimes be told from a global one, and the
answer says which.** `spec-registry.aliasForTenant` returns the tenant's
overlay when one covers the environment and the global pin when it does not,
and never reports which. The overlay file is never *parsed* here — the pin rule
stays the registry's — but its **name** is probed with `lstat`, exactly as
`manifest.json`'s is and for the same reason, because its absence settles the
question: with no overlay file the value can only be the global pin, and this
tenant has no binding of its own. That is `currentPinScope:
"global-tenant-has-no-overlay"`. With a file there, or a name that could not be
classified, the ambiguity stands and the scope is `"tenant-or-global"`.

The distinction is not cosmetic, because the fallback was being read as a
definite answer in *both* directions. Read as "already pinned, nothing to do",
it left a tenant that asked for an explicit pin with no overlay at all. Read as
"pinned elsewhere, so moving it destroys a binding", it **refused** a tenant's
first-ever overlay with `code: "conflict"` and "the previous binding would
exist nowhere afterwards" — a statement about a binding that did not exist, and
a push toward `repin:true`, the flag whose whole meaning is accepting the loss
of what it replaces. Neither reading survives; the first overlay is written,
and a genuine tenant move is still refused with the ambiguity spelled out.

**What the tenant view cannot enumerate, it names.** `spec-registry` exposes no
way to list the environments a tenant's overlay covers, and `pinForTenant` does
not require a global pin for the environment it writes. So `DeployInspect`'s
per-environment tenant list is the spec's *global* pins, an environment pinned
only for that tenant does not appear in it unless `env` names it, and the
answer carries `environmentsListed` and `incompleteBecause` saying exactly
that. An empty list is "no globally pinned environment", not "this tenant
resolves nothing".

**Nothing this package did not write is echoed raw.** A manifest's `pins` keys
and `versions` entries, a `listSpecs` directory name, a caller's `actor` and
`deployment-controller`'s own record all reach the same model's context a
refusal message does, so they all go through the same bounding-and-neutralising
`render`. It costs nothing legitimate: every name involved has to satisfy one
of `spec-registry`'s grammars to mean anything, and none of those admits a
control character or a 200-character name.

## One prediction, reported rather than assumed

`SpecPin`'s dry run has to say what `autoRegisterSpecVersion` would do without
letting it write, and that decision lives inside a function that decides and
writes in one call. So the preview re-evaluates it — using the changelog
package's own `contentHash` over the same stored bytes, not a second hashing
rule — and the real path then reports what actually happened *plus*
`predictionHeld`. If the two ever drift the tool says so instead of presenting
the prediction as the outcome, and `lib.test.ts` runs both against the same
registry across the first-version, unchanged, changed and
re-registering-an-old-version cases and requires them to agree. A version that
could not be read makes the prediction `undetermined` rather than "would
register a new one".

Note that the hash is over the **exact YAML bytes**, which is
`@crewhaus/spec-changelog`'s documented behaviour ("the registry stores bytes
verbatim"): reformatting a spec without changing its meaning mints a new
version. The survey sketch for `SpecPin` asked for a canonical-form hash
instead. Doing that here would be a second content-identity rule disagreeing
with the one the changelog, the CLI's `spec put` and `crewhaus compile` all
share — the drift this architecture exists to avoid. If canonical hashing is
wanted, it belongs in `spec-changelog`, where every caller gets it at once.

## Tests

```
bunx biome check --write packages/tool-deploy
bun test packages/tool-deploy/src
```

`index.test.ts` drives the three tools against real directories under the OS
temp dir and asserts what is on disk afterwards — the manifest's pins, the
version files, the changelog, the tenant overlay — not what the returned JSON
claims. Every refusal test asserts the *reason*, because a tool that failed for
an unrelated reason would also satisfy "status is refused". `lib.test.ts` pins
the couplings this package mirrors from `spec-registry` against what the real
adapter writes, so an upstream rename breaks a test rather than quietly leaving
a write path uncontained.
