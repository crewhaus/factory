# Recipe 26 — Template Marketplace

Browse, install, and publish spec templates through a sigstore-style
signed marketplace. The same registry pattern works against a local
directory, a git repo, an HTTPS endpoint, or a Hugging Face / npm
mirror — pluggable backend.

You'd reach for this when:

- Your team has **a small library of well-known specs** that
  developers should bootstrap from, not start from scratch.
- You want to **share recipes externally** (community templates,
  marketplace listings).
- You need **signature verification** so an installed template can
  prove its provenance.

For one-off specs, just copy from `examples/`. The marketplace is
the right answer when "many people install from a known source."

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  spec format you'll be publishing.

## The `RegistrySource` interface

```typescript
interface RegistrySource {
  list(): Promise<TemplateMetadata[]>;
  fetch(name: string): Promise<TemplateManifest>;
  metadata?(name: string): Promise<TemplateMetadata>;
}
```

Three methods, all async. `list()` returns lightweight metadata
(name, version, description, target) for browsing; `fetch()` returns
the full manifest (including the spec YAML body, optional screenshots,
optional signature).

## Built-in sources

### `LocalRegistrySource`

A file-backed registry under `<path>/`:

```
<path>/
  hello-cli/
    manifest.json
    spec.yaml
    screenshots/
      thumbnail.png
  slack-bot/
    manifest.json
    spec.yaml
```

Refuses **path traversal** at every read: a `name` containing `/`,
`..`, or null bytes is rejected. So an attacker who can submit a
template name can't read `/etc/passwd` via `fetch("../../etc/passwd")`.

### `HttpRegistrySource`

Generic HTTP source — covers git, Hugging Face, npm, your own
registry:

```typescript
const source = new HttpRegistrySource({
  listUrl: "https://registry.example.com/list",
  fetchUrl: (name) => `https://registry.example.com/templates/${encodeURIComponent(name)}`,
});
```

The caller supplies `listUrl` and `fetchUrl(name)` — the source
fetches and parses, handling redirects (capped at 5), body limits (2MB
default), and timeout (30s default).

## TTL caching

For network-backed sources, the runtime wraps with TTL caching:

```typescript
import { cachedRegistry } from "@crewhaus/template-registry";

const cached = cachedRegistry({ source: httpSource, ttlMs: 60_000 });
await cached.list();    // hits the network
await cached.list();    // returns the cached result
await cached.refresh(); // forces a re-fetch
```

`refresh()` flushes the cache; the next `list()` re-fetches. Useful
when you know a new template was just published and want to see it
without waiting for TTL.

## Signature verification

For trusted publishing, wrap with `verifyingRegistry`:

```typescript
import { verifyingRegistry } from "@crewhaus/template-registry";

const verified = verifyingRegistry({
  source: cachedSource,
  trustRoot: ["ed25519:base64-pub-key-1", "ed25519:base64-pub-key-2"]
});

const manifest = await verified.fetch("slack-bot");
// throws if:
//   - manifest has no signature field
//   - signature's publicKey isn't in trustRoot
//   - signature doesn't verify against the manifest's canonical JSON
```

The trust root is a small list of authorized publishers' public keys.
For an open marketplace this is everyone you've vetted; for a
corp-internal registry, it's the keys held by your release team.

Refuses three failure modes:

1. **Unsigned manifest** — explicit refusal so publishing a template
   without signing is impossible by accident.
2. **Untrusted signer** — the publickey isn't in `trustRoot`.
3. **Tampered manifest** — the signature doesn't verify against
   canonical JSON.

## Manifest schema

```json
{
  "name": "slack-bot",
  "version": "1.0.2",
  "description": "Channel-target Slack bot with permission rules.",
  "author": "alice@example.com",
  "target": "channel",
  "yaml": "name: my-bot\ntarget: channel\n...",
  "exampleEnv": ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  "screenshots": ["https://.../thumb.png"],
  "publicKey": "ed25519:abc...",
  "signature": "base64:def..."
}
```

**Canonical JSON ordering** keeps signatures stable: a manifest with
the same fields signed by the same author always produces the same
signature. The runtime canonicalizes via lexicographic key order
before signing and before verification.

## The `MarketplaceClient`

The user-facing entry:

```typescript
import { MarketplaceClient } from "@crewhaus/template-marketplace-client";

const client = new MarketplaceClient({ registry: verifiedRegistry });

await client.list();
await client.search({ query: "slack", target: "channel", limit: 10 });
await client.install("slack-bot", { subdir: "agents", filename: "crewhaus.yaml" });
```

### `search`

Search is **name-priority**: results matching the query in the name
field rank above results matching only in the description. Author
and target are filters, not ranking signals.

### `install`

Writes the manifest's `yaml` field to `<subdir>/<filename>` (default
`./<name>/crewhaus.yaml`). Also writes an `.env.example` with any
`exampleEnv` entries so users know what secrets they need.

For verified registries, `install` re-checks the signature before
writing — defense in depth against a cache poisoned between `fetch`
and write.

## CLI surface

```bash
crewhaus marketplace list
crewhaus marketplace search "slack"
crewhaus marketplace install slack-bot
```

Same options as the JS API; `crewhaus marketplace install slack-bot --subdir agents`
writes to `./agents/slack-bot/crewhaus.yaml`.

## Publishing

`MarketplacePublisher.draftPublish({ registryName, manifest })`
produces a `PublishDraft`:

```typescript
{
  title: "Add slack-bot 1.0.2 to the public registry",
  body: "...generated markdown...",
  manifestJson: "...canonical JSON..."
}
```

The publisher does **not** open a PR itself — the caller's git client
(Studio's GitHub integration or `gh`) submits the draft as a PR.
This keeps git auth out of the publisher.

In Studio ([Recipe 35](35-studio-walkthrough.md)), the publish flow
is one button: it generates the draft, signs the manifest with the
user's stored Ed25519 key, and submits the PR via the user's GitHub
OAuth.

For manual / CLI publishing:

```bash
crewhaus marketplace publish ./my-template/ \
  --signing-key-env CREWHAUS_PUBLISHING_KEY \
  --registry https://registry.example.com
# → prints the draft + the PR command
```

## Wiring a custom registry source

```typescript
class MyRegistrySource implements RegistrySource {
  async list() {
    const res = await fetch("https://my-internal.example.com/list");
    return res.json();
  }
  async fetch(name: string) {
    // refuse path traversal:
    if (name.includes("/") || name.includes("..")) {
      throw new Error("invalid name");
    }
    const res = await fetch(`https://my-internal.example.com/templates/${encodeURIComponent(name)}`);
    return res.json();
  }
}

const client = new MarketplaceClient({
  registry: verifyingRegistry({
    source: cachedRegistry({ source: new MyRegistrySource(), ttlMs: 60_000 }),
    trustRoot: ["ed25519:..."]
  })
});
```

The TTL → verifying → caching composition is the recommended pattern
for production: cache the upstream source, then verify on every
`fetch` (cache hit doesn't bypass verification — it caches the
already-verified manifest).

## Studio integration

The Marketplace tab in Studio ([Recipe 35](35-studio-walkthrough.md))
embeds the same client. Browse → search → install lands the spec in
the user's `~/.crewhaus/projects/<project>/` directory. The publish
flow signs + submits a PR with one click.

## Things that look like a marketplace but aren't

| Symptom                                                          | Better tool                                    |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Sharing specs internally with no signing concern.                | Just commit them to a shared repo.              |
| Distributing **runtime plugins**, not specs.                     | `crewhaus plugin install` (a separate flow).   |
| Versioning your own team's specs.                                | [Spec registry](21-deployment-and-canary.md).  |

## What to read next

- **Studio integration.** [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md).
- **Spec versioning vs marketplace.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Publishing the editor plugins.** [Recipe 25 — VS Code and JetBrains](25-vscode-and-jetbrains.md).

## Pointers to source

- **Registry library:** [`packages/template-registry`](../../packages/template-registry).
- **Marketplace client:** [`packages/template-marketplace-client`](../../packages/template-marketplace-client).
- **Scaffold templates (built-in):** [`packages/scaffold-templates`](../../packages/scaffold-templates).
- **Module catalog reference:** §40 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
