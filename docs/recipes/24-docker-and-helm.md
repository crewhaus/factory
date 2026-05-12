# Recipe 24 — Docker and Helm

Build per-target Docker images, single-binary cross-platform releases,
and a Helm chart that handles the daemon vs non-daemon distinction.
Plus package manifests for Homebrew, Debian, Scoop, and winget so end
users can `brew install crewhaus`.

You'd use this when:

- You ship to Kubernetes — Helm is the lingua franca.
- You distribute the CLI as an end-user binary, not a Bun script.
- You want **reproducible** images (same digest from same source).

For dev / single-host deployments, plain `bun run` against the
compiled bundle is simpler. Reach for Docker + Helm when "the team /
customer can't run Bun directly."

## Prerequisites

- Docker installed locally for image builds.
- Optional: a Kubernetes cluster (k3d / kind work fine) for Helm.

## The 12 Dockerfiles

One per target shape under [`packages/docker-images`](../../packages/docker-images).
All:

- Base on `oven/bun:1.2-alpine` for small footprint (~50MB compressed).
- Run as **non-root** user `crewhaus` (uid 1100).
- `readOnlyRootFilesystem: true` compatible — writes only to
  `/tmp` (tmpfs) and `/app/state/` (volume mount).
- Carry a **healthcheck** sized to the target:

| Target shape         | Healthcheck                                                |
| -------------------- | ---------------------------------------------------------- |
| Daemon shapes (`channel`, `managed`, `voice`) | `httpGet /healthz`                  |
| `batch`               | `exec bun /app/crewhaus.js doctor --batch`                  |
| `cli`, `workflow`, `eval`, `research`, etc. | `exec bun /app/crewhaus.js doctor` |
| `browser`             | `httpGet /healthz` (browser worker has a tiny HTTP shim)  |

### Building

```bash
crewhaus build-image cli --tag crewhaus-cli:dev
```

Wraps `docker buildx build` with:

- **Reproducibility.** Sets `SOURCE_DATE_EPOCH` to the spec's git
  commit timestamp; uses `--no-cache` by default; writes the resulting
  digest to `docker/digests.json`.
- **Multi-arch.** `--platform linux/amd64,linux/arm64` builds both;
  one digest entry per platform.
- **Push.** `--push` requires `DOCKER_REGISTRY` env var and pushes
  the digest tag.

Per-shape flags inject the right entry point and ENV:

```bash
crewhaus build-image channel --tag crewhaus-channel:dev \
  --build-arg AGENT_NAME=hello \
  --tag-suffix slack
```

## Single-binary releases

`bun build --compile` produces a standalone binary that embeds Bun
itself. Five supported targets:

| Target          | Triple                       | Output                              |
| --------------- | ---------------------------- | ----------------------------------- |
| `linux-x64`     | `x86_64-unknown-linux-gnu`   | `crewhaus`                          |
| `linux-arm64`   | `aarch64-unknown-linux-gnu`  | `crewhaus`                          |
| `macos-x64`     | `x86_64-apple-darwin`        | `crewhaus`                          |
| `macos-arm64`   | `aarch64-apple-darwin`       | `crewhaus`                          |
| `windows-x64`   | `x86_64-pc-windows-msvc`     | `crewhaus.exe`                       |

```bash
bun run build:binary --target linux-x64 --version v0.1.0
```

Output: `dist/v0.1.0/crewhaus-linux-x64.tar.gz` plus the binary
itself. Binaries are ~80MB each because they bundle Bun.

For releases, the GitHub Actions workflow builds all five targets in
parallel, uploads them as release assets, and triggers the package
manifest auto-update.

## Package manifests

[`packages/single-binary-cli`](../../packages/single-binary-cli)
auto-generates manifests for four distribution channels:

| Channel    | File written                                  | Install command                                |
| ---------- | --------------------------------------------- | ---------------------------------------------- |
| Homebrew   | `Formula/crewhaus.rb`                          | `brew install crewhaus/tap/crewhaus`           |
| Debian     | `debian/crewhaus.control`                      | `apt install crewhaus`                         |
| Scoop      | `bucket/crewhaus.json`                         | `scoop install crewhaus`                       |
| winget     | `manifests/crewhaus/crewhaus.installer.yaml`   | `winget install crewhaus`                      |

Each generator is deterministic — same release inputs produce
byte-identical manifests. `writeAllManifests()` dumps all four into
a directory ready to PR into the relevant tap/bucket repos.

Homebrew formulas carry both `on_macos` and `on_linux` blocks so the
same formula covers macOS and Linuxbrew installs:

```ruby
class Crewhaus < Formula
  desc "..."
  homepage "..."
  version "0.1.0"

  on_macos do
    on_arm do
      url "...crewhaus-macos-arm64.tar.gz"
      sha256 "..."
    end
    on_intel do
      url "...crewhaus-macos-x64.tar.gz"
      sha256 "..."
    end
  end

  on_linux do
    on_arm do ... end
    on_intel do ... end
  end
end
```

## The Helm chart

At [`packages/helm-chart`](../../packages/helm-chart). Standard
structure:

```
helm/crewhaus/
  Chart.yaml
  values.yaml
  templates/
    deployment.yaml
    service.yaml
    ingress.yaml
    servicemonitor.yaml          # gated on serviceMonitor.enabled
    otel-collector.yaml          # gated on otel.enabled
    _helpers.tpl
```

`values.yaml` schema (abridged):

```yaml
target: channel                  # picks daemon vs non-daemon templates
image:
  repository: crewhaus-channel
  tag: v0.1.0
  pullPolicy: IfNotPresent
replicas: 3                      # daemon shapes scale horizontally
resources:
  requests: { cpu: 200m, memory: 256Mi }
  limits:   { cpu: 1000m, memory: 1Gi }
env:
  - name: ANTHROPIC_AUTH_TOKEN
    valueFrom: { secretKeyRef: { name: crewhaus-secrets, key: anthropic-token } }
  - name: SLACK_BOT_TOKEN
    valueFrom: { secretKeyRef: { name: crewhaus-secrets, key: slack-bot-token } }
ingress:
  enabled: true
  host: bot.example.com
  className: nginx
serviceMonitor:
  enabled: true                  # creates a Prometheus Operator ServiceMonitor
otel:
  enabled: true                  # creates an OTel-collector sidecar ConfigMap
persistence:
  enabled: true                  # PVC for .crewhaus/sessions/
  size: 10Gi
  storageClass: standard
```

### Daemon vs non-daemon

The chart's templates branch on `target`:

| Target shape         | Resources generated                                                |
| -------------------- | ------------------------------------------------------------------ |
| `channel` / `managed` / `voice` | Deployment + Service + Ingress + httpGet readiness/liveness |
| `batch`               | Deployment (no Service) + exec readiness                            |
| `cli` / `workflow` / `eval` / `research` | Job (not Deployment) + exec readiness                  |

Job vs Deployment matters: a CLI run finishes; a daemon doesn't.
`helm install` of a CLI target spawns one Job; `helm install` of a
channel target spawns a multi-replica Deployment.

### Installing

```bash
helm install bot ./packages/helm-chart -f my-values.yaml
```

Or from a published chart repo (if your team publishes one):

```bash
helm repo add crewhaus https://charts.crewhaus.example.com
helm install bot crewhaus/crewhaus -f my-values.yaml
```

### Upgrades

```bash
helm upgrade bot ./packages/helm-chart -f my-values.yaml \
  --set image.tag=v0.2.0
```

The Deployment template uses `RollingUpdate` strategy with
`maxUnavailable: 1`, `maxSurge: 1`. For canary-style rollouts at the
spec level (1% → 10% → 50%), see [Recipe 21](21-deployment-and-canary.md).

### Persistence considerations

Channel and managed daemons write session JSONL to
`.crewhaus/sessions/`. Without a PVC, every restart loses session
history. With a PVC, restarts pick up in-flight threads.

For multi-replica daemons, the PVC must be `ReadWriteMany` (NFS,
EFS) or you need to route requests to specific replicas by session
key. The bundled Helm chart assumes RWX storage for `replicas > 1`.

## ServiceMonitor and OTel collector

When `serviceMonitor.enabled: true`, the chart generates a
Prometheus Operator `ServiceMonitor` pointing at the daemon's
`/metrics` endpoint:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: bot
spec:
  selector:
    matchLabels: { app: bot }
  endpoints:
    - port: metrics
      interval: 30s
```

When `otel.enabled: true`, an OTel-collector sidecar runs alongside
each daemon pod, configured via a ConfigMap. The collector receives
OTLP from the daemon and forwards to whatever exporter you wire (see
Recipe 17 for the four vendor exporters).

## Operating tips

- **Health probe tuning.** Default readiness `initialDelaySeconds: 5`,
  `periodSeconds: 10`. For slow boots (MCP servers spawning), raise
  `initialDelaySeconds` to give them time.
- **Pod disruption budgets.** For daemons, set `pdb.minAvailable: 1`
  in `values.yaml` so node-drain doesn't take the whole service down.
- **Image pull secrets.** For private registries, set
  `imagePullSecrets: [{ name: my-registry-creds }]` in values.

## Running the smokes

```bash
bun run smoke:section-32         # exercises image builds + binary + helm template
```

The smoke runs `docker build` for one target shape, `bun build --compile`
for the host platform, and `helm template` over the bundled chart with
default values. Catches structural drift between codegen and packaging
when target shapes are added.

## What to read next

- **One-click cloud deploy.** [Recipe 36 — Cloud Deploy](36-cloud-deploy.md).
- **Editor integration.** [Recipe 25 — VS Code and JetBrains](25-vscode-and-jetbrains.md).
- **Observability after deployment.** [Recipe 17 — Observability](17-observability.md).

## Pointers to source

- **Docker images:** [`packages/docker-images`](../../packages/docker-images).
- **Single-binary CLI:** [`packages/single-binary-cli`](../../packages/single-binary-cli).
- **Helm chart:** [`packages/helm-chart`](../../packages/helm-chart).
- **Cloud deploy:** [`packages/crewhaus-cloud`](../../packages/crewhaus-cloud).
- **Module catalog reference:** §32 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
