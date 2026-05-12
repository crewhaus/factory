# Recipe 21 — Deployment and Canary

Manage spec versions like code. Store them in a registry, pin which
version each environment runs, promote and roll back via audit-logged
operations, and cut over from `vN` to `vN+1` with a percent-of-traffic
canary gated on a real eval-runner regression check.

You'd reach for this when:

- You operate **multiple environments** (dev, staging, prod) and need
  one source of truth for which spec is running where.
- You need **safe promotions** — vN+1 only goes to 100% if it
  out-evals vN.
- You need **fast rollback** — one command reverts an environment to
  the prior version, audit-logged.

If you're running one CLI agent locally, this is overkill. The
spec-registry and friends are designed for multi-tenant managed
deployments.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the deployment surface.
- [Recipe 12 — Eval Harness](12-eval-harness.md) for the regression
  gate.

## The spec registry

The registry is **file-backed by default** under
`.crewhaus/specs/`:

```
.crewhaus/specs/
  agent-name/
    v1.yaml
    v2.yaml
    v3.yaml
    manifest.json
  _tenants/
    tenant-a/
      agent-name.json     # overlay: pin to a specific version for this tenant
```

`manifest.json` is the source of truth:

```json
{
  "versions": ["v1", "v2", "v3"],
  "envs": {
    "dev": "v3",
    "staging": "v3",
    "prod": "v2"
  },
  "aliases": {
    "stable": "v2",
    "latest": "v3"
  }
}
```

Operations on the registry:

```bash
crewhaus spec put agent-name v3 ./my-spec.yaml     # add a version
crewhaus spec list agent-name                       # list versions + env pins
crewhaus spec get agent-name v3                     # print a version's spec
crewhaus spec pin agent-name prod v3                # pin an env to a version
crewhaus spec alias agent-name stable v3            # update an alias
```

`pin` is the only operation that changes what production runs. Every
pin write is **audit-logged** in the deployment audit (`crewhaus
deploy log`).

## Tenant overlays

Some tenants want to pin to an older version (regulatory hold) or
a newer version (early-access beta). Overlay files in
`_tenants/<tenantId>/<spec>.json`:

```json
{ "version": "v2" }
```

The runtime resolution order:

1. Look for `_tenants/<tenantId>/<specName>.json`. If present, use
   that version.
2. Otherwise, use the env pin from `manifest.json` for the deployment's
   environment.

Overlays don't copy the spec — just point at an existing version. So
all tenants share the same vetted set of versions, but can be on
different ones.

## IR-passes — what runs between parse and emit

After the YAML parses and lowers to IR, the compiler runs zero or
more `ir-passes` ([packages/ir-passes](../../packages/ir-passes)).
Each pass is a `(IrNode) → IrNode` function that re-shapes the IR
without changing semantics:

| Pass                                 | What it does                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| `deadToolElimination`                | Removes `tools:` entries no instructions actually reference.       |
| `redundantMcpServerCollapse`         | Folds two MCP servers that declare the same `command + args` into one. |
| `permissionRuleCanonicalization`     | Sorts permission rules (deny > ask > allow), dedupes.              |
| `promptCachePrefixSort`              | Reorders cacheable prefix blocks so cache-hit rate is stable.       |

**Idempotency.** Every pass is `apply(apply(x)) === apply(x)`. That
means re-running the compiler on an already-canonicalized IR is a
no-op, which lets the migration engine round-trip safely.

## IR migrations

The IR schema evolves (new fields, renamed keys, fixed defaults).
Migrations are versioned `up`/`down` steps:

```typescript
// packages/migration-engine/src/migrations/2024-04-rename-foo.ts
export const migration = {
  fromVersion: "1.3",
  toVersion: "1.4",
  up(ir: IrV13): IrV14 { ... },
  down(ir: IrV14): IrV13 { ... }
};
```

To migrate the whole registry:

```bash
crewhaus migrate-all
```

Walks every spec in `.crewhaus/specs/`, computes the chain of `up`
steps from each spec's IR version to the current IR version, and
applies them. The chain is reversible — `migrate-all --down --target v1.3`
walks `down` steps.

Migration is the right answer when the schema changes; canary is the
right answer when the **behavior** changes. The two compose: a
migration shaves off the schema delta, then canary rolls the
behavior delta.

## The deployment controller

```bash
crewhaus deploy promote agent-name --from staging --to prod
crewhaus deploy rollback agent-name --env prod --to v2
```

Promote semantics:

1. Reads the version pinned to `from`.
2. Pins `to` to that version.
3. Audits the change with `{ actor, from-version, to-version, env }`.

Rollback semantics:

1. Asserts the target version exists.
2. Pins the env to it.
3. Audits with `{ actor, prev-version, target-version, env, reason }`.

Both are **atomic** writes to `manifest.json` (tempfile + rename).
A concurrent promote and rollback will serialize; one wins, the
other sees the updated manifest and fails-or-retries based on its
flags.

## The canary controller

A canary splits traffic between two versions:

```bash
crewhaus canary start agent-name --env prod --version v3 --weight 1
```

Means: 1% of prod traffic goes to v3; the other 99% stays on the
pinned version (v2). Routing is **stable** by request hash:

```
sha256(tenantId | requestId) mod 100 < weight → canary version
otherwise                                       → stable version
```

So the same user's requests stick to the same side. No flapping
between versions mid-conversation.

Bump weight in steps:

```bash
crewhaus canary set agent-name --weight 10
crewhaus canary set agent-name --weight 50
crewhaus canary set agent-name --weight 100   # full cutover
```

At 100%, the controller auto-promotes (pins prod to v3) and ends the
canary.

## The regression gate

Before each weight bump, the regression runner compares versions on
the eval dataset:

```bash
crewhaus regression-gate agent-name --prev v2 --next v3 \
  --thresholds 'passRate>=0.95,scoreDelta>=-0.02,latencyP95Ratio<=1.2'
```

The gate:

1. Runs the eval dataset (`packages/dataset-registry`) against both
   versions.
2. Computes deltas: pass rate, mean score, p95 latency.
3. Returns `pass` if every threshold is met; `fail` otherwise.

Wire this between canary weight steps:

```bash
crewhaus canary set agent-name --weight 10
crewhaus regression-gate agent-name --prev v2 --next v3 --thresholds '...' \
  || crewhaus canary abort agent-name
crewhaus canary set agent-name --weight 50
```

`canary abort` rolls back the in-flight canary: the env's pin
reverts to the pre-canary version, the canary record audits its
abort reason. No partial cutover sticks.

For full automation, the bundled rollout script does the steps + the
gates with one command:

```bash
crewhaus canary auto-rollout agent-name --steps 1,10,50,100 --gate-thresholds '...'
```

## A worked progression

```
T+0:    crewhaus spec put agent-name v3 ./new-spec.yaml
T+0:    crewhaus canary start agent-name --env prod --version v3 --weight 1
T+30m:  crewhaus regression-gate ... → pass
T+30m:  crewhaus canary set agent-name --weight 10
T+1h:   crewhaus regression-gate ... → pass
T+1h:   crewhaus canary set agent-name --weight 50
T+2h:   crewhaus regression-gate ... → pass
T+2h:   crewhaus canary set agent-name --weight 100 → auto-promote
```

Total: 2h gate-by-gate ramp on real prod traffic, with a
regression-runner backstop at each step. Failure at any step rolls
back.

## Observability of a canary in flight

Two key metrics, exposed by `canary-controller`:

| Metric                                   | What it shows                                       |
| ---------------------------------------- | --------------------------------------------------- |
| `canary_traffic_share`                    | Current weight (1, 10, 50, ...).                   |
| `canary_response_pass_rate{version=...}`  | Per-side pass rate from the eval grader.           |
| `canary_response_p95_latency{version=...}` | Per-side latency.                                  |

The Recipe 17 grafana panel includes these by default. A canary that
fails on either pass rate or latency should be visible **before** the
regression gate confirms it on the next check.

## Operational checklist

- **First-time setup.** `crewhaus spec init` creates `.crewhaus/specs/`
  with an empty manifest.
- **Audit retention.** Deploy audit lives under `.crewhaus/audit/deploy/`.
  Volume-mount in production.
- **Multi-environment.** Each environment (dev/staging/prod) has its
  own registry root; they don't share `manifest.json`. To promote
  cross-env, the deploy controller copies the version file too.
- **Drift detection.** `crewhaus deploy drift` compares the in-tree
  manifest with the running daemons' loaded specs. Any mismatch is a
  drift event.

## What to read next

- **Eval harness behind the gate.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Audit-logged promotions.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Kubernetes / Helm deployment.** [Recipe 24 — Docker and Helm](24-docker-and-helm.md).

## Pointers to source

- **Spec registry:** [`packages/spec-registry`](../../packages/spec-registry).
- **IR-passes:** [`packages/ir-passes`](../../packages/ir-passes).
- **Migration engine:** [`packages/migration-engine`](../../packages/migration-engine).
- **Migration runner:** [`packages/migration-runner`](../../packages/migration-runner).
- **Deployment controller:** [`packages/deployment-controller`](../../packages/deployment-controller).
- **Canary controller:** [`packages/canary-controller`](../../packages/canary-controller).
- **Regression runner:** [`packages/regression-runner`](../../packages/regression-runner).
- **Module catalog reference:** §28, §29 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
