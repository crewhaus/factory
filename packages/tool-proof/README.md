# @crewhaus/tool-proof

The tools a harness uses to prove its claims, and to check a draft answer before it sends it.
They are the tool surface of the provability ladder (`provability:` in a spec: cited, grounded,
checked, proven).

```yaml
tools:
  - all-proof        # the tools below (also part of all-safety)
```

| Tool | What it does |
|---|---|
| `ProofCheckers` | Lists the proof checkers this harness can use, in preference order: whether each can run here (and why not), and the statement language each one checks |
| `ProofCheck` | Runs a checker on `{ checker, claim, statement, proof }` and saves the verdict as a `prf_…` artifact. On ok the answer cites it as `[n]: proof:prf_…` |
| `ProvabilityPreflight` | Grades `{ draft }` with the gate's own verifier and returns the verdict, a row per claim and what to fix. Gates nothing |

Nothing here cites for the model, and nothing calls a model. A checker's verdict is the only
thing `ProofCheck` trusts; the preflight is the same `verifyDocument` the gate runs, over the same
evidence. A spec with a `provability:` block gets `ProvabilityPreflight` from the gate itself
(`@crewhaus/evaluation-service`), and `ProofCheckers` and `ProofCheck` too at `proven` or when its
`formal.checkers` is not the default. All three are bound to the gate's configuration, and any of them
the spec also lists in `tools:` is replaced by the bound one. The builtin instances serve a spec
without the block.

## Checkers

From [`@crewhaus/proof-checker`](../proof-checker), in the order `provability.formal.checkers`
gives (default `builtin`, `smt`), with `builtin` always appended when the list leaves it out:

- `builtin`: exact finite arithmetic and logic. No sandbox, always available.
- `smt`: SMT-LIB 2 checked by Z3 in a container sandbox.
- `lean4`: Lean 4 in a container sandbox.

The sandbox checkers are listed whenever the config names them. They get a container sandbox
when the run says one is wired or `CREWHAUS_SANDBOX` selects `docker` or `podman` (unset means
docker); under `noop`, or a value that names no backend, they show as unavailable with the
reason. With a sandbox, availability is the image's healthcheck, so a missing daemon or image
reads as unavailable with why, and the first probe may wait on a cold pull. `ProofCheck` refuses
an unknown or unavailable checker before anything is checked or saved.

## Artifacts and events

Every check that runs is saved, accepted or rejected, under
`<cwd>/.crewhaus/proofs/<spec>/artifacts/<prf_id>.json` (mode 0600, never overwritten). A
rejected proof is kept because it is signal: the bundle can then say why a citation of it
failed. A check that never finishes is saved as a rejection once it runs past `formal.timeoutMs`
plus `CHECK_GRACE_MS` (30 s); a cancelled call saves nothing.

On the managed shape each turn runs inside its tenant, and the tools file artifacts under the
tenant's own root (`<tenantRoot>/proofs/<spec>/`) and read its own sessions. A root outside the
tenant is refused.

Each check publishes a `proof_checked` trace event on the run's bus (`checker`, `ok`,
`artifactId`, `durationMs`, `axioms`) and appends the same payload to the run's session event
log.

## API

`createProofTools(opts?): ProofTools` builds the tools (`proofCheckers`, `proofCheck`,
`provabilityPreflight`, and `all`) over one configuration:

| Option | Meaning |
|---|---|
| `config` | The lowered `provability:` block. Default: the compiler's defaults at the `grounded` floor (`defaultProvabilityConfig()`). |
| `specName` / `proofsRoot` | Where artifacts are filed: `<workspaceRoot>/.crewhaus/proofs/<specName>/`, or a root you name. |
| `workspaceRoot` | Where path sources resolve (default: `process.cwd()` at call time). |
| `checkers` | The checkers, in preference order. Default: `buildDefaultCheckers(config, …)`, built on first use. |
| `sessionRootDir` | Where session logs live, when no `evidence` is injected. Default: the run's, the tenant's, `CREWHAUS_SESSION_DIR`, `.crewhaus/sessions`. |
| `evidence` | `(ctx) => Promise<EvidenceIndex \| { index, turnNumbers?: Set<number> }>`: what the preflight grades against. A builder that rejects or returns anything else, or a `turnNumbers` that is not a `Set`, fails the call. Default: the run's session log, scoped by `config.scope`. |
| `checkTimeoutMs` | The backstop before a check is saved as a rejection (default `formal.timeoutMs + CHECK_GRACE_MS`). |
| `now` | Clock for `checkedAt` (tests). |

The roots are resolved on every call, for the tenant the call runs under, so one instance built
at boot serves every tenant of a managed daemon. Pass `specName` and `workspaceRoot` and let the
tools resolve the root per call, or pass a function of the tenant, such as
`(tenant) => defaultProofsRoot(cwd, spec, tenant)`. Do not pass a `proofsRoot` string resolved at
boot to a managed daemon: no tenant exists then, and a root outside the call's tenant is
refused, so every managed call would fail. `sessionRootDir` works the same way. The gate's
composition root calls `createProofTools` with the spec's block, its proofs resolver and the
evidence builder its verifier uses, so the gate and the tools always agree.

The exported builtin instances (`proofCheckers`, `proofCheck`, `provabilityPreflight`,
`PROOF_TOOLS`) are what a spec gets by listing the tools without a `provability:` block: the
compiler's defaults at the `grounded` floor, artifacts under `.crewhaus/proofs/default/` (a run
context carries no spec name), and the run's session log as evidence.

The pieces are exported for the gate and the CLI: `buildDefaultCheckers`, `defaultCheckerIds`,
`sandboxImages`, `listCheckers`, `probeChecker`; `runChecker`, `toArtifact`, `checkReport`;
`preflightBundle`, `preflightConfig`, `preflightReport`; `sessionEvidence`, `currentTurn`,
`startsTurn`; `proofRecheck` / `recheckProof` (the builtin checker re-running a stored builtin
proof, the gate's `recheckProof`); `defaultProofsRoot`, `defaultSessionRoot`, `tenantRootOf`,
`runtimeStateRoots` (the run's own state directories, which the gate and the preflight both
refuse as sources) and `STATE_ENV_VARS`; and the bounds `PROOF_INPUT_LIMITS`, `REPORT_BYTES`,
`DRAFT_CHARS`.

## Flags

| Tool | readOnly | concurrencySafe | destructive | requiresSandbox | scope |
|---|---|---|---|---|---|
| `ProofCheckers` | yes | yes | no | no | internal |
| `ProofCheck` | no | yes | yes (writes one artifact) | no | internal |
| `ProvabilityPreflight` | yes | yes | no | no | internal |

`ProofCheck` is not `requiresSandbox`: the builtin checker needs none, and a tool-level flag would
deny it on every sandbox-less harness. The sandbox checkers refuse themselves without a sandbox
and on the `noop` backend, so the sandbox floor applies per checker rather than per tool.

Its operative argument is `checker`, so a permission rule can scope it: `alwaysAllow
ProofCheck(builtin)` allows the sandbox-free checker alone. permission-engine carries that rule
as a builtin default, beside `alwaysAllow` for `ProofCheckers` and `ProvabilityPreflight`, so a
`proven` harness reaches its floor through the builtin checker without approval on every
surface. `smt` and `lean4` start a container and keep the mode's default (allow them with
`alwaysAllow ProofCheck(smt)`, `ProofCheck(lean4)`).

## Reports

Each report is small enough for the model to read whole (`REPORT_BYTES`), since the runtime shows
only the start of a large tool result. The verdict and what to do next come first, then the
details. The preflight lists unmet claims first and counts any it had no room for; the full proof
and output stay in the artifact.

## What the preflight does not do

It never leaves the run. Compared with the gate it skips three steps, with a note in the report
wherever one would have mattered:

- **HEAD requests** (`sources.resolve: head`): no URL is contacted; the draft is checked as if
  `resolve` were `off`.
- **Replay** (`checked`): cited tools are not re-run; bindings read `replayed: false`.
- **The paraphrase judge**: never consulted. A paraphrase the gate's judge might accept shows as
  `not_found_in_source` here, so the preflight is the stricter of the two.

It does re-check a stored builtin proof and refuse the run's own state directories as sources,
as the gate does.

## Tests

```sh
bun test src
```

The suites pin the package-wide flags and bounds (`index`), run the tools through the executor
(`integration`), cover `ProofCheck` with the builtin checker, a scripted sandbox and plugin
checkers that misbehave (`check`), the listing with and without a sandbox (`checkers`), the
tenant fencing (`tenancy`), and the preflight's parity with the gate (`preflight`). No test needs
Docker; the sandbox checkers' real images are exercised by `@crewhaus/proof-checker`'s gated live
test.

Design: [design/0.8.0-provability-release.md](../../design/0.8.0-provability-release.md) §6.4, §7.
