# Recipe 30 — Sandboxed Code Execution

> **Status:** stub.

## What you'll learn

Give the agent `Python`, `JavaScript`, and `Shell` REPL tools that run
inside Docker sandboxes — network=none, read-only root, scratch tmpfs,
image allow-list. Plus seven polyglot images on the same registry
pattern (Go, Rust, Java, Ruby, R, .NET, PHP) so you can extend the set
without changing runtime-core.

## Prerequisites

- Docker (or Podman) installed and accessible.
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) for tool flag behavior.

## Roadmap

1. The `sandbox` package: `createSandbox(opts)` → `{exec(command, stdin?, env?)}` returning `{stdout, stderr, exitCode, durationMs}`.
2. Backends: `docker` (default), `podman`, `noop` (in-process; tests only — opt-in via `CREWHAUS_SANDBOX=noop`).
3. Hardening defaults: network=none, 512 MB memory, 1.0 CPU, 60 s timeout, read-only root, scratch tmpfs at `/tmp`, mount whitelist, image allow-list (`CREWHAUS_SANDBOX_ALLOWED_IMAGES`).
4. Built-in code-execution tools: `Python` → `python:3.13-slim`, `JavaScript` → `node:22-alpine`, `Shell` → `alpine:3.19`. All `concurrencySafe=false, readOnly=false, destructive=true, requiresSandbox=true`.
5. Warm pool tuning — cold-start ≤500 ms target.
6. Streaming: stdout/stderr stream through the trace bus as `tool_stream_chunk` events.
7. The polyglot image registry: `registerSandboxImage(...)` + `lookupSandboxImage(...)` + `listSandboxImages()`. Healthcheck contract per image.
8. Adding a polyglot image — Go / Rust / Java / Ruby / R / .NET / PHP all follow the same pattern.
9. The `crewhaus sandbox doctor [--probe]` CLI walks the registry and reports image-pull / healthcheck status.
10. The prompt-injection detector — wired into the post-tool path; malicious output is stripped, suspicious is kept-but-warned.

## Run it now

```bash
bun run smoke:section-18
bun run smoke:section-36-registry
bun apps/cli/src/index.ts sandbox doctor --probe
```

## Pointers to existing material

- **Modules:** [`packages/sandbox`](../../packages/sandbox), [`packages/tool-code-execution`](../../packages/tool-code-execution), [`packages/prompt-injection-detector`](../../packages/prompt-injection-detector), [`packages/sandbox-image-registry`](../../packages/sandbox-image-registry).
- **Polyglot images:** [`packages/sandbox-image-go`](../../packages/sandbox-image-go), [`packages/sandbox-image-rust`](../../packages/sandbox-image-rust), [`packages/sandbox-image-java`](../../packages/sandbox-image-java), [`packages/sandbox-image-ruby`](../../packages/sandbox-image-ruby), [`packages/sandbox-image-r`](../../packages/sandbox-image-r), [`packages/sandbox-image-dotnet`](../../packages/sandbox-image-dotnet), [`packages/sandbox-image-php`](../../packages/sandbox-image-php).
- **Catalog:** §18, §36.

## Where to go next

- For untrusted-eval workloads (managed shape running unknown code) → [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- For permission posture around destructive tools → [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
