# @crewhaus/tool-proof

The tools a harness uses to prove its claims, and to check a draft answer
before it sends it. They are the tool surface of the provability ladder
(`provability:` in a spec — cited, grounded, checked, proven).

```yaml
tools:
  - all-proof        # the three tools below (also part of all-safety)
```

| Tool | What it does |
|---|---|
| `ProofCheckers` | Lists the proof checkers this harness can use, in preference order: whether each can run here (and why not), and the statement language each one checks |
| `ProofCheck` | Runs a checker on `{ checker, claim, statement, proof }` and saves the verdict as a `prf_…` artifact. On ok the answer cites it as `[n]: proof:prf_…` |
| `ProvabilityPreflight` | Grades a draft with the gate's own verifier and returns the verdict, a row per claim and what to fix. Gates nothing |

Nothing here cites for the model, and nothing calls a model. A checker's
verdict is the only thing `ProofCheck` trusts; the preflight is the same
`verifyDocument` the gate runs.

## Checkers

From `@crewhaus/proof-checker`, in the order `provability.formal.checkers`
gives (default `builtin`, `smt`):

- `builtin` — exact finite arithmetic and logic. No sandbox, always available.
- `smt` — SMT-LIB 2 checked by Z3 in a container sandbox.
- `lean4` — Lean 4 in a container sandbox.

The builtin is always in the list. The sandbox checkers are listed whenever
the config names them; without a container sandbox (`CREWHAUS_SANDBOX=docker`
or `podman`) they show as unavailable with the reason, and `ProofCheck`
refuses them.

## Artifacts and events

Every check is saved, accepted or rejected, under
`<cwd>/.crewhaus/proofs/<spec>/artifacts/<prf_id>.json` (mode 0600, never
overwritten). A rejected proof is kept because it is signal: the bundle can
then say why a citation of it failed. A check that never finishes is saved as
a rejection once it runs past `formal.timeoutMs` plus a grace period; a
cancelled call saves nothing.

On the managed shape each turn runs inside its tenant, and the tools file
artifacts under the tenant's own root (`<tenant>/proofs/<spec>/`) and read
its own sessions. A root outside the tenant is refused.

Each check publishes a `proof_checked` trace event on the run's bus and
appends the same line to the run's session event log.

## Configuration

`createProofTools(opts)` builds the three tools over one configuration. The
gate's composition root (`@crewhaus/evaluation-service`) calls it with the
spec's lowered `provability:` block, the spec name and the evidence builder
its verifier uses, so the gate and the tools always agree.

The roots are resolved on every call, for the tenant the call runs under, so
one instance built at boot serves every tenant of a managed daemon. Pass
`specName` and `workspaceRoot` and let the tools resolve
`<tenant>/proofs/<spec>/` per call (`.crewhaus/proofs/<spec>/` outside a
tenant). Do not pass a `proofsRoot` string resolved at boot: no tenant exists
then, and a root outside the call's tenant is refused, so every managed call
would fail. To choose the root yourself, pass a function of the tenant, such
as `(tenant) => defaultProofsRoot(cwd, spec, tenant)`. `sessionRootDir` works
the same way. The gate's own artifact store must resolve its root the same
way, per turn, or it will not find the proofs the tools saved.

The exported builtin instances — what a spec gets by listing the tools in
`tools:` without a `provability:` block — use the compiler's defaults at the
`grounded` floor, file artifacts under `.crewhaus/proofs/default/`, and read
the run's session log as evidence.

An injected evidence builder returns the index, or `{ index, turnNumbers }`
so that `scope: turn` is applied the way the gate applies it.

## Flags

| Tool | readOnly | concurrencySafe | destructive | requiresSandbox | scope |
|---|---|---|---|---|---|
| `ProofCheckers` | yes | yes | no | no | internal |
| `ProofCheck` | no | yes | yes (writes one artifact) | no | internal |
| `ProvabilityPreflight` | yes | yes | no | no | internal |

`ProofCheck` is not `requiresSandbox`: the builtin checker needs none. The
sandbox checkers refuse themselves without a sandbox, and on the `noop`
backend, so the sandbox floor applies per checker rather than per tool.

Its operative argument is `checker`, so a permission rule can scope it:
`alwaysAllow ProofCheck(builtin)` allows the sandbox-free checker alone.

## Reports

Each report is small enough for the model to read whole: the runtime shows
only the start of a large tool result. The verdict and what to do next come
first, then the details. The preflight lists unmet claims first and counts
any it had no room for; the full proof and output stay in the artifact.

## What the preflight does not do

It never leaves the run. Compared with the gate it skips three steps:

- **HEAD requests** (`sources.resolve: head`): no URL is contacted; the draft
  is checked as if `resolve` were `off`, and a note says so.
- **Replay** (`checked`): cited tools are not re-run; bindings read
  `replayed: false`, and a note says the gate replays.
- **The paraphrase judge**: never consulted. A paraphrase the gate's judge
  might accept shows as unmet here, so the preflight is the stricter of the two.
