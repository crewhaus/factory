# Recipe 36 — Cloud Deploy

Deploy a managed crewhaus daemon to AWS / GCP / Azure (or LocalStack
for local dev) via the composite `crewhaus-cloud` recipe — Terraform
for cluster + database, Helm for the workload, three deployment tiers
(dev / default / production).

You'd use cloud deploy when:

- You're shipping to a real cloud and want a **one-command** path.
- You want **infra-as-code** rather than clickops in the cloud
  console.
- You want **tier-driven sizing** — start at dev, scale up via a
  tier change.

For an existing Kubernetes cluster, use the Helm chart directly
([Recipe 24](24-docker-and-helm.md)) and skip Terraform. For a
docker-compose dev environment, use the LocalStack tier.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) —
  the workload you're deploying.
- [Recipe 24 — Docker and Helm](24-docker-and-helm.md) — the
  bundled chart cloud-deploy uses.
- Cloud provider credentials configured locally
  (AWS CLI / `gcloud` / `az`).
- Terraform installed (or use the LocalStack tier for dev).

## `defaultCloudConfig`

The entry point that picks reasonable defaults per provider:

```typescript
import { defaultCloudConfig } from "@crewhaus/crewhaus-cloud";

const config = defaultCloudConfig({
  provider: "aws",      // "aws" | "gcp" | "azure" | "aws-localstack"
  region: "us-east-1",
  tier: "default"
});
```

Returns a fully-formed config that downstream functions consume.
Override any field directly — `defaultCloudConfig` is the starting
point, not the only path.

## The three tiers

| Tier         | Shapes deployed                         | Replicas                     | Cost profile |
| ------------ | --------------------------------------- | ---------------------------- | ------------ |
| `dev`        | One shape (your choice)                 | 1 replica                    | Smallest.    |
| `default`    | managed gateway + batch worker          | 2 + 2                        | Production-ish. |
| `production` | Full multi-shape (channel + managed + batch + voice...) | 3 each | Full multi-AZ. |

`tierShapes(tier)` returns the list of shapes for a tier; `tierReplicas(tier)`
returns the per-shape replica counts. Custom tiers via:

```typescript
config.tier = "custom";
config.shapes = ["managed", "batch"];
config.replicas = { managed: 5, batch: 10 };
```

## Terraform module rendering

`renderTerraformModule(config)` produces provider-specific
infrastructure:

### AWS

```hcl
resource "aws_eks_cluster" "crewhaus" { ... }
resource "aws_db_instance" "postgres" { ... }
resource "aws_s3_bucket" "session_storage" { ... }
resource "aws_secretsmanager_secret" "anthropic_token" { ... }
```

EKS for compute, RDS Postgres for audit / session metadata, S3 for
session JSONL archives, Secrets Manager for credentials.

### GCP

```hcl
resource "google_container_cluster" "crewhaus" { ... }
resource "google_sql_database_instance" "postgres" { ... }
resource "google_storage_bucket" "session_storage" { ... }
resource "google_secret_manager_secret" "anthropic_token" { ... }
```

GKE / Cloud SQL / GCS / Secret Manager.

### Azure

```hcl
resource "azurerm_kubernetes_cluster" "crewhaus" { ... }
resource "azurerm_postgresql_flexible_server" "postgres" { ... }
resource "azurerm_storage_account" "sessions" { ... }
resource "azurerm_key_vault" "secrets" { ... }
```

AKS / Postgres Flexible / Storage Account / Key Vault.

### LocalStack

```hcl
provider "aws" {
  endpoints {
    s3 = var.localstack_endpoint
    rds = var.localstack_endpoint
    eks = var.localstack_endpoint
  }
  skip_credentials_validation = true
}
# Same AWS resources, pointed at LocalStack
```

LocalStack-shaped AWS for local dev. Same resource definitions; just
endpoint-overridden.

## Kustomize overlays

`renderKustomizeOverlay(config)` produces a deterministic
`kustomization.yaml` + per-shape rendered manifests:

```
out/
  kustomization.yaml
  base/
    managed-deployment.yaml
    batch-deployment.yaml
    ...
  overlays/
    {tier}/
      patches.yaml
```

Deterministic = same config produces byte-identical output, useful
for diff-based review of infra changes.

## `deployCloud` — the orchestrator

```typescript
import { deployCloud } from "@crewhaus/crewhaus-cloud";

const result = await deployCloud({
  config,
  runner: undefined          // injected runner for tests; uses TF_BIN by default
});
```

Steps:

1. **`terraform init`** — install provider plugins, configure backend.
2. **`terraform plan`** — show the diff. Aborts if `--auto-approve` not set.
3. **`terraform apply`** — provision infra.
4. **`terraform output`** — fetch cluster credentials, DB endpoint, etc.
5. **`kubectl apply -k .`** — apply the kustomize overlay.

Gates on **`TF_BIN`** env var. If set, uses that as the Terraform
binary. If not set:

- Tests use the injected `runner` for hermetic execution.
- CLI without `TF_BIN` falls back to "skip" with a clear error.

So unit-level CI doesn't need Terraform; the live deploy job does.

## `teardownCloud`

```typescript
await teardownCloud({ config });
```

Mirrors `deployCloud` in reverse:

1. `kubectl delete -k .` — remove the workload.
2. `terraform destroy` — destroy infra.

Has the same TF_BIN gating + same runner injection pattern. Always
runs in a controlled order so cluster destruction waits for workload
removal.

## CLI

```bash
crewhaus cloud deploy --provider aws --region us-east-1 --tier dev
crewhaus cloud deploy --provider gcp --region us-central1 --tier production
crewhaus cloud teardown --provider aws --region us-east-1
```

Standard flags:

| Flag                | Default                                                |
| ------------------- | ------------------------------------------------------ |
| `--provider`         | required                                                |
| `--region`           | required                                                |
| `--tier`             | `default`                                                |
| `--auto-approve`     | false (require interactive confirmation)                 |
| `--state-backend`    | `s3` for AWS, `gcs` for GCP, `azurerm` for Azure         |

## State management

Terraform state lives in the cloud bucket / blob storage:

| Provider | Backend                                                            |
| -------- | ------------------------------------------------------------------ |
| AWS      | S3 bucket `crewhaus-tfstate-<account>-<region>` with DynamoDB lock. |
| GCP      | GCS bucket `crewhaus-tfstate-<project>-<region>`.                  |
| Azure    | Azure Blob `crewhaus-tfstate-<subscription>-<region>`.             |

The bootstrap (creating the state bucket itself) is a one-time manual
step. `crewhaus cloud bootstrap` automates it:

```bash
crewhaus cloud bootstrap --provider aws --region us-east-1
```

Creates the state bucket / lock table / RBAC for subsequent deploys.

## Multi-environment deploys

Three patterns:

### Different regions, same provider

```bash
crewhaus cloud deploy --provider aws --region us-east-1 --tier production
crewhaus cloud deploy --provider aws --region eu-west-1 --tier production
```

Each region has its own state bucket; deploys are independent. Useful
for data residency.

### Different providers, same workload

```bash
crewhaus cloud deploy --provider aws --region us-east-1 --tier dev
crewhaus cloud deploy --provider gcp --region us-central1 --tier dev
```

Run the same workload across providers. Useful for portability
validation.

### Dev → staging → prod with different tiers

```bash
crewhaus cloud deploy --provider aws --region us-east-1 --tier dev    # dev cluster
crewhaus cloud deploy --provider aws --region us-east-1 --tier default # staging
crewhaus cloud deploy --provider aws --region us-east-1 --tier production # prod
```

Each is a separate Terraform workspace; state isolation is enforced
by the backend.

## Smoke

```bash
bun run smoke:section-32
```

Exercises the full deploy / teardown loop with an **injected runner**
(no actual cloud calls). Validates:

- `defaultCloudConfig` for all four providers.
- Terraform module rendering for all four.
- Kustomize overlay rendering for all three tiers.
- `deployCloud` order of operations.
- `teardownCloud` order of operations.

The smoke is fast (no docker, no Terraform, no kubectl) — it's a
structural validation, not a live deploy.

## Operating tips

- **Bootstrap once per account.** Re-running `crewhaus cloud bootstrap`
  is idempotent — the state bucket creation is `IfNotExists`.
- **Lock contention.** Terraform's lock prevents concurrent applies.
  If your CI parallelizes deploys, serialize them on the state lock.
- **Drift detection.** `crewhaus cloud plan` (under the hood
  `terraform plan`) shows what would change. Useful before applying.
- **Secrets.** Anthropic credentials go through the provider's
  secrets store (AWS Secrets Manager, GCP Secret Manager, Azure
  Key Vault). Helm values reference the secret by ARN/ID.
- **Cost.** A dev tier on AWS runs ~$50/mo (one small node group).
  Production tier with full observability ~$500-$1000/mo before
  inference costs.

## Things that look like cloud deploy but aren't

| Symptom                                                          | Better tool                                    |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Existing k8s cluster, want to install the workload.              | [Helm chart](24-docker-and-helm.md) directly.   |
| Local dev with no cloud account.                                  | LocalStack tier or docker-compose.              |
| One-host production (small startup).                              | Single VM + the binary ([Recipe 24](24-docker-and-helm.md)). |
| Cross-deployment role calls.                                       | [Federation](27-federation.md).                  |

## What to read next

- **Per-tenant policy + audit on the deployed gateway.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Canary rollouts on the deployment.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Observability after deployment.** [Recipe 17 — Observability](17-observability.md).

## Pointers to source

- **Module:** [`packages/crewhaus-cloud`](../../packages/crewhaus-cloud).
- **Module catalog reference:** §32 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
