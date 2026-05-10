# Recipe 24 — Docker and Helm

> **Status:** stub.

## What you'll learn

Build per-target Docker images, single-binary cross-platform releases,
and a Helm chart that handles the daemon vs non-daemon distinction.
Also: package manifests for Homebrew, Debian, Scoop, and winget so
end users can `brew install crewhaus`.

## Prerequisites

- Docker installed locally for image builds.
- Optional: a Kubernetes cluster (or k3d / kind) for Helm.

## Roadmap

1. The 12 Dockerfiles — one per target shape, all `oven/bun:1.2-alpine`-based, non-root user, read-only root, healthcheck.
2. `crewhaus build-image <target> --tag <tag> [--platform <p>] [--push]` — wraps `docker buildx build` with reproducibility (`docker/digests.json`).
3. Single-binary builds: `bun build --compile` per (platform, arch). 5 supported targets: linux x64/arm64, macos x64/arm64, windows x64.
4. Auto-generated package manifests: Homebrew formula (on_macos + on_linux blocks), Debian control, Scoop manifest, winget manifest. `writeAllManifests()` dumps all of them deterministically.
5. The Helm chart at `helm/crewhaus/`: Chart.yaml, values.yaml, per-shape templates (deployment, service, ingress, servicemonitor, otel-collector, _helpers.tpl).
6. Daemon vs non-daemon shapes: daemon shapes get Service + Ingress + httpGet healthchecks; non-daemon shapes get an exec healthcheck via `bun /app/crewhaus.js doctor`.
7. ServiceMonitor + OTel-collector ConfigMap gated on `serviceMonitor.enabled` / `otel.enabled`.
8. The `crewhaus-cloud` recipe — composite "managed-as-a-service" with Terraform and Kustomize for AWS / GCP / Azure / LocalStack.

## Run it now

```bash
# Build a Docker image for a target shape:
bun apps/cli/src/index.ts build-image cli --tag crewhaus-cli:dev

# Build the cross-platform single binary:
bun run build:binary --target linux-x64 --version v0.1.0

# In-tree smoke that exercises image builds + single-binary + helm:
bun run smoke:section-32
```

## Pointers to existing material

- **Modules:** [`packages/docker-images`](../../packages/docker-images), [`packages/single-binary-cli`](../../packages/single-binary-cli), [`packages/helm-chart`](../../packages/helm-chart), [`packages/crewhaus-cloud`](../../packages/crewhaus-cloud).
- **Catalog:** §32.

## Where to go next

- For one-click cloud deployment → [Recipe 36 — Cloud Deploy](36-cloud-deploy.md).
- For VS Code / JetBrains spec authoring + run-from-editor → [Recipe 25 — VS Code and JetBrains](25-vscode-and-jetbrains.md).
