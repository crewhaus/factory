# Recipe 36 — Cloud Deploy

> **Status:** stub.

## What you'll learn

Deploy a managed crewhaus daemon to AWS / GCP / Azure (or LocalStack
for local dev) via the composite `crewhaus-cloud` recipe — Terraform
for cluster + database, Helm for the workload, three deployment tiers
(dev / default / production).

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
- Cloud provider credentials configured locally (AWS CLI / `gcloud` / `az`).
- Terraform installed (or use the LocalStack tier for dev).

## Roadmap

1. `defaultCloudConfig({provider, region})` — picks reasonable defaults across `aws | gcp | azure | aws-localstack`.
2. The three tiers and their `tierShapes()`:
   - **dev** — single shape, single replica, smallest footprint.
   - **default** — common production: managed gateway + queue worker.
   - **production** — full multi-shape deployment with observability + secrets manager.
3. `renderTerraformModule()` per provider:
   - AWS: `aws_eks_cluster + aws_db_instance + aws_s3_bucket`.
   - GCP: `google_container_cluster + google_sql_database_instance`.
   - Azure: `azurerm_kubernetes_cluster + azurerm_postgresql_flexible_server`.
   - LocalStack: AWS shape with `endpoints { s3 = var.localstack_endpoint }`.
4. `renderKustomizeOverlay()` — deterministic kustomization.yaml + per-shape rendered manifests.
5. `deployCloud({config, runner?})` — orchestrates `terraform-init → terraform-apply → terraform-output → kubectl-apply`. Gates on `TF_BIN` (or injected runner; falls back to `skip` when neither).
6. `teardownCloud()` mirrors `deployCloud` for clean rollback.
7. CLI: `crewhaus cloud deploy --provider aws --region us-east-1` and `crewhaus cloud teardown`.
8. State management: where the Terraform state lives and how to lock it.

## Run it now

```bash
# Smoke (uses injected runner; no real cloud required):
bun run smoke:section-32

# Live AWS dev tier (requires AWS creds + Terraform):
bun apps/cli/src/index.ts cloud deploy --provider aws --region us-east-1 --tier dev
```

## Pointers to existing material

- **Module:** [`packages/crewhaus-cloud`](../../packages/crewhaus-cloud).
- **Catalog:** §32.

## Where to go next

- For per-tenant policy + audit on the deployed gateway → [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- For canary rollouts of new spec versions → [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
