# @crewhaus/tool-discovery

Finding out what is out there, as deterministic tools: what templates the local
marketplace holds, and which federation peers are actually reachable.

```yaml
tools:
  - marketplaceSearch
  - federationDiscover
```

| Tool | What it does |
|---|---|
| `MarketplaceSearch` | Search a local template registry — spec templates and grader templates — by name, description, target or kind, with each manifest's signature verdict |
| `FederationDiscover` | Look up federation peers and report which are healthy, which answered badly, and which did not answer at all |

Two tools with opposite risks, which is why they share a package.
`MarketplaceSearch` never opens a socket; its danger is the **content** it
returns. `FederationDiscover` returns almost nothing; its danger is the
**reach**.

## The real registries, not a second implementation

| Rule | Where it lives |
|---|---|
| What a manifest is, and what an absent `kind` means | `templateKind` in `@crewhaus/template-registry` |
| Whether a grader-template's assets are valid | `validateGraderTemplate` |
| Whether a signature verifies, and against what canonical JSON | `verifyManifest` |
| Listing and fetching a file-backed registry | `LocalRegistrySource` |
| The embedded first-party grader-template library | `firstPartyGraderTemplates` |
| How a peer is resolved, and what a peer record must contain | `createDiscovery` in `@crewhaus/federation-discovery` |
| The TTL cache and the negative TTL | the same `Discovery` object, shared across calls |
| Whether an address is private, in any of its spellings | the synchronised classifier block, byte-identical with `@crewhaus/tool-fetch` |

This package contributes the schema, the containment, the network guard, the
quoting and the result shape. It holds no second copy of any of those rules.

## The three outcomes are three outcomes

`@crewhaus/federation-discovery` gives a caller two answers: a `PeerRecord`, or
a `FederationDiscoveryError` that covers a refused connection, a 503, a body
that is not JSON and a fingerprint of the wrong length with the same throw.
Collapsing those makes a federation look smaller than it is, or healthier than
it is. `FederationDiscover` reports five:

| Outcome | What it means | What it does not mean |
|---|---|---|
| `healthy` | It answered with a well-formed record, and everything you pinned held | Not "it can serve traffic" — no federation call is made |
| `unhealthy` | It answered, and the answer is wrong. **The peer is up** | |
| `unreachable` | Nothing came back — connection refused, name did not resolve, deadline elapsed | Not "the peer is gone" |
| `refused` | This tool did not ask. A guard stopped it, or the peer id is not one the library will resolve | **Not down.** Nothing at all is known about it |
| `undetermined` | The sweep was cut short before this peer's turn, or the run was cancelled | Also not down |

Each carries a stable `code` (`unhealthy:http-503`, `unreachable:timeout`,
`refused:private`, …) to branch on and a `reason` to read. The verdict is
decided from an **attempt record** written at the moment the socket did or did
not produce bytes — never from the text of a library's exception, because a
library is free to reword its messages and a tool that greps them turns a
reword into a wrong answer about production.

The summary has a column per outcome and no combined one. There is deliberately
no `peersUp` field: the two questions "how many are healthy" and "how many are
not down" have different answers and folding them is the bug.

## What `FederationDiscover` does on the wire

A peer id is attacker-influenced input, and this tool turns it into a URL and
dials it. So, in order:

1. Scheme must be http or https; a `user:pass@` URL is refused outright.
2. When an operator has bound an allow-list, the origin must be on it.
3. Loopback, link-local (including `169.254.169.254`), RFC1918, CGNAT,
   multicast and reserved ranges are refused — as an IP literal in **any** of
   its encodings (`0177.0.0.1`, `2130706433`, `127.1`, `::ffff:a9fe:a9fe`,
   `64:ff9b::a9fe:a9fe`) and as the DNS-resolved address of a name.
4. The vetted IP is what the socket connects to, with the original hostname
   kept for `Host` and TLS SNI. Resolving in the guard and letting `fetch`
   re-resolve at connect time is the DNS-rebinding TOCTOU the guard exists to
   close.
5. Redirects are **not followed**. A 3xx is reported as the peer's answer.
6. Every request is deadline-bounded; every body is capped at 256 KiB.

And one thing a plain fetch guard does not do: the endpoint the peer
**advertises** is vetted too. That is the address whatever federates next will
dial, and it went through none of the checks the peer id did. A peer answering
from a public name with `endpoint: https://169.254.169.254` is `unhealthy`, by
name.

Two verdicts on that advertised endpoint are deliberately *not* health
findings. `unresolvable` means this resolver could not answer, and
`not-allow-listed` means this process's policy has not permitted that origin —
both are facts about here, not there, so they go to `unknowns` and
`endpointDialable` is `null` rather than `false`.

`endpointDialable` is also `null` — never `true` — when `allowPrivateHosts` is
set. That flag short-circuits name resolution, so the guard returns "not
refused" without having looked anything up, and reporting that as dialable
would claim a fact nothing established.

A body that hit the 256 KiB cap is **not parsed**. The prefix of a cut document
can still be valid JSON (a well-formed record padded with whitespace parses
fine), the unread tail is a different document, and in JSON a later duplicate
key wins — so the bytes that were never read could carry a second `endpoint`.
Such a peer is `unhealthy:body-too-large`: it is up, and its answer is unusable.
The row's `attempt` carries `truncated` and, for a 3xx, the `location` that was
recorded and not followed.

### The operator gates

Neither gate is a field in any tool's input schema. A gate a model can open for
itself is not a gate.

```ts
import { setPeerPolicy, setMarketplaceTrustRoot } from "@crewhaus/tool-discovery";

// Reach a local federation fixture, or restrict dialling to known origins.
setPeerPolicy({ allowPrivateHosts: false, allowedOrigins: ["https://peer.example"] });

// The keys manifest signatures are checked against.
setMarketplaceTrustRoot({ publicKeys: [pem] });
```

An empty `allowedOrigins` array means *nothing* may be dialled, not *anything*.

## Could not determine is not no

The dominant failure class, and both tools are built around it.

- A registry directory that could not be listed is **refused as unreadable**,
  never returned as an empty marketplace.
- `LocalRegistrySource.list()` silently skips a manifest it cannot parse. That
  is right for the library and wrong for a search tool, so the `*.json` files
  on disk are compared with the names the listing returned and the gap is
  reported under `unknowns`, with the path and the reason. `registry` carries
  both `manifestFiles` and `templates` so the gap is visible without reading
  further.
  The gap list is bounded at 50 entries, with the true total reported when
  there are more: `results` is paged and this has to be too, or one junk
  directory answers a search with a thousand `unknowns`.
- A **signed** manifest with no trust root bound gets `signature: null` and an
  entry saying no trust root is configured. It is not reported as unsigned and
  not as untrusted; neither is known. An unsigned manifest is `unsigned`
  whatever the trust root says.
- `list()` returns one row **per file**, keyed on the `name` *inside* the file,
  while `fetch(name)` reads `<name>.json`. Those are the same file only when a
  manifest's name matches its filename and no other file claims that name. So
  the identity is proved per row before a verdict is attributed: when the
  manifest at that path is not the one the row was listed from, `signature` is
  `null` with the reason. Without it, a second file that merely copies a name
  inherits the verdict earned by the first one's bytes — an impostor row shown
  as `verified`. Collisions are reported under `registry.names.<name>` and
  counted in `registry.duplicateNames` whether or not a trust root is bound.
- A pin whose key names no peer in the sweep is listed in `pinsNotApplied`
  rather than dropped. One mistyped id would otherwise leave a fleet reported
  healthy with the pin its operator thought they had set unenforced.
- A peer that did not answer is `unreachable`; a peer this tool declined to
  contact is `refused`; a peer it never got to is `undetermined`.

Every `null` in a result has a matching entry in `unknowns` naming the field,
the probe and the reason — and `index.test.ts` walks the returned JSON and
fails if one does not.

## Authored text is data

A template's `name`, `description`, `author` and `target`, and a peer's
`endpoint`, `version` and `supportedShapes`, are written by somebody else and
land in a model's context as the answer to a question the model asked. That is
the indirect prompt-injection channel.

Every such string is carried inside a named `authored` object, never
interpolated into a sentence of the tool's own, under a top-level `dataNotice`
saying so. Control bytes, C1 codes, bidi overrides and zero-width characters
are replaced, the field is length-capped, and **every substitution is reported**
in `authoredSanitized` — on a template row and on a peer's `record` alike, a
silently altered field is its own kind of lie. A library error that quotes the
peer's own text (the discovery library interpolates the endpoint into its
message) is quoted on the way out too.

That applies wherever the text lands, not only under `authored`. A manifest's
own `name` becomes a path in `unknowns[].probe` and is interpolated into the
registry's own `invalid template name "…"`; a registry FILENAME becomes an
`unknowns[].field`. Both go through the same quoting — otherwise the identical
string arrives sanitized in one field and raw two fields later, which is what
the `renderPath` and `errText` this package borrowed from
`@crewhaus/tool-lifecycle` did: that copy replaces C0 and DEL, the right set
for the only thing *it* is handed (a path the caller wrote) and not enough for
a string an attacker authored.

There is no "does this look like an injection" heuristic here.
`@crewhaus/tool-secure`'s `PromptInjectionScan` is the repository's, it is a
smoke detector by its own documentation, and a second half-hearted copy in a
package that does not depend on it would buy nothing but false confidence. The
defence is that the text is data and is labelled as data.

Filtering runs on the **parsed** value, not on the sanitized display copy, so a
description containing a zero-width character still matches the word it plainly
contains. The row then says which fields had to be sanitized.

One consequence worth knowing: a row's `name` is quoted like every other
authored field, so when `authoredSanitized` contains a `name:` entry, the
printed name is *not* the byte-for-byte key the registry stores that manifest
under. That manifest needs its name fixed before anything can address it — and
`MarketplaceSearch` reports exactly that under `unknowns` when the read it
would have done fails.

## Containment

Every caller-supplied path goes through `resolveSafe` (copied verbatim from
`@crewhaus/tool-pkg`), which refuses anything resolving outside `process.cwd()`
— including through a symlink inside the workspace, and including a dangling
one.

The paths this tool actually opens are the **leaves**: `list()` does its own
`readdir` + `readFileSync` over every `*.json` in the registry directory, and
`fetch(name)` opens `<registryDir>/<name>.json` where `name` came out of a file
somebody else wrote. So each leaf is contained before the read, and a symlink
at `<registry>/innocent.json` pointing outside the workspace refuses the whole
call rather than being skipped — the listing that followed would be a listing
of a directory somebody has already tampered with.

`MarketplaceSearch` also stats the registry directory **before** constructing
`LocalRegistrySource`, which would otherwise `mkdir` it: a read-only search
that creates a tree on a typo has both written something nobody asked for and
turned "that registry does not exist" into "that registry is empty".

## What these tools do not do

- **No install.** `MarketplaceSearch` has no install flag and never will:
  fetching a template and trusting it are different operations with different
  blast radii, and the one that writes files owns signature verification.
- **No federation call.** `FederationDiscover` reads `.well-known` and stops.
  `healthy` means resolvable and self-describing, not able to serve traffic.
- **No DNS SRV.** `@crewhaus/federation-discovery` supports
  `_crewhaus._tcp.<deployment>.<domain>`, and this tool does not expose it. An
  SRV hit still requires the same `.well-known` fetch to get shapes and a
  fingerprint, so SRV only changes *which host is dialled* — and turning a
  caller-supplied peer id into a DNS-directed redirection is surface this tool
  is not opening. Use `discoverDeployment` from the library directly when an
  operator-configured `srvDomain` is wanted.
- **No semver.** `requireVersion` is compared for equality. A range would be a
  rule, and the version rule belongs to `@crewhaus/federation-protocol`, which
  this package does not depend on.

## Caching

The discovery client is shared across calls, on purpose: the TTL cache is what
keeps a fleet sweep from re-resolving every peer every minute, and the negative
TTL is what keeps a misconfigured peer from causing a DNS storm. Both belong to
`@crewhaus/federation-discovery`; this package neither sets nor re-derives
them.

A result says which answers came from it. A cached hit is `healthy:cached`; a
cached miss is `unreachable:cached` with a reason saying the lookup was not
repeated. `refresh: true` clears the cache first.

Because that per-sweep state and the shared client are process-wide,
`FederationDiscover` declares `concurrencySafe: false`. `MarketplaceSearch`,
which holds nothing, is concurrency-safe.
