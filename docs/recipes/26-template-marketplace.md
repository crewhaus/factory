# Recipe 26 — Template Marketplace

> **Status:** stub.

## What you'll learn

Browse, install, and publish spec templates through a sigstore-style
signed marketplace. Same registry pattern works against a local
directory, a git repo, an HTTPS endpoint, or a Hugging Face / npm
mirror — pluggable backend.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. The `RegistrySource` interface — `list` / `fetch` / `metadata`.
2. Built-in sources:
   - `LocalRegistrySource` (file-backed; refuses path traversal).
   - `HttpRegistrySource` (covers git / Hugging Face / npm; caller supplies `listUrl` + `fetchUrl(name)`).
3. `cachedRegistry({source, ttlMs})` — TTL caching with `refresh()` flush.
4. `verifyingRegistry({source, trustRoot})` — Ed25519 signature verification on `fetch`. Refuses unsigned manifests, refuses signatures from public keys not in the trust root, refuses tampered manifests.
5. Manifest schema: `{name, version, description, author, target, yaml, exampleEnv?, screenshots?, signature?, publicKey?}`. Canonical JSON ordering keeps signatures stable.
6. The `MarketplaceClient`: `list()`, `search({query, target, author, limit})` (name match outranks description-only), `install(name, {subdir?, filename?})`.
7. Publishing: `MarketplacePublisher.draftPublish({registryName, manifest})` produces a `PublishDraft` (title + body + manifestJson) the caller's git client (Studio's GitHub integration or `gh`) submits as a PR.
8. Studio Marketplace tab — discover-and-install in the browser.

## Run it now

```bash
bun run smoke:section-40-registry
bun run smoke:section-40-marketplace
```

## Pointers to existing material

- **Modules:** [`packages/template-registry`](../../packages/template-registry), [`packages/template-marketplace-client`](../../packages/template-marketplace-client), [`packages/scaffold-templates`](../../packages/scaffold-templates).
- **Catalog:** §40.

## Where to go next

- For Studio integration → [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md).
- For supply-chain hardening of plugins (not just templates) — see §41 in the v1.3 roadmap (`build-roadmap.md`).
