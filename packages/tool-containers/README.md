# @crewhaus/tool-containers

What is actually behind this image tag.

| Tool | Answers |
|---|---|
| `ContainerImageInspect` | which digest does this tag resolve to, and what is inside it |
| `ContainerImageTags` | what versions of this image exist |

Both talk to the OCI distribution API directly. No daemon, no `docker pull`, no
layers downloaded, nothing written to disk — resolving a tag to a digest costs
one or two small GETs, and the image config blob (labels, entrypoint, created
time) costs one more.

## The digest is computed, not believed

A manifest's digest is `sha256` over the exact bytes the registry sent. That
makes it fragile in a specific way: parse the JSON and serialize it again — a
different key order, two spaces instead of three, a literal `é` where the
registry wrote `é` — and the hash is a different number that still looks
exactly like a digest. Every image you "pinned" then matches nothing, and "this
is the image we tested" is false while reading as true.

So the bytes are held as bytes from the socket to the hash. Nothing on the
digest path is parsed before it is hashed, and nothing is ever re-serialized.
The registry's `Docker-Content-Digest` header is **checked against the computed
digest, never copied from it**, and the result reports both whether a header was
present and whether it agreed. When you ask for `…@sha256:abc`, or when a
multi-arch index promises a per-platform digest, the bytes that come back are
verified against that promise too, and a mismatch is a refusal rather than a
field in the output.

## Multi-arch is two answers, so it returns two

A tag on a modern image is usually an **index**, not an image: one digest
covering several per-platform manifests. Both digests are real and they are used
for different things, so both are reported — `resolved` is what the tag points
at, `manifest` is the single-platform image inside it (`linux/amd64` by default,
`platform` to choose, `indexOnly` to stop at the index).

Buildkit also writes provenance and SBOM manifests into the index with the
platform `unknown/unknown`. Those are counted as `attestations` and are never
selectable — picking one and reporting it as the image is the classic multi-arch
bug.

Two more things the platform string alone does not settle. Asking for
`linux/arm64` gets the **variant-less** entry when the index has one, whatever
order the index lists it in, because that is the image a plain arm64 host would
pull. And `windows/amd64` is usually several images that differ only in
`os.version`; when more than one entry matches, the chosen one's `osVersion` and
a `platformMatches` count travel with the answer, because a digest picked
blindly out of that set will not run.

## The auth dance, from the challenge

Public images need a token: the registry answers 401 with a
`WWW-Authenticate: Bearer realm=…,service=…` challenge, the client fetches a
token from that realm and retries. This is driven entirely off the challenge, so
Docker Hub, ghcr.io and quay.io all work without appearing in the code — and so
does the registry nobody here has tried yet. The one registry-specific rule is a
naming one: `alpine` means `registry-1.docker.io/v2/library/alpine`.

The challenge is data from a server, so it is treated as such. The realm must be
an absolute `https` URL with no credentials in it, and the scope requested is
**ours** — a challenge asking us to request `repository:someone/else:push` gets
a pull scope for the repository the caller actually named.

## What it refuses

A tool that cannot say no is not finished. These say no, with the reason:

- **a digest that does not match its content** — from the header, from the
  reference, or from an index descriptor;
- **a private repository** — after an anonymous token has been tried, reported
  as private rather than as missing, because no retry fixes it;
- **a registry offering only Basic auth**, naming what it offered;
- **a schema 1 manifest**, whose digest covers a JWS signature rather than the
  image content;
- **a platform the index does not have**, listing the ones it does;
- **a redirect or an auth realm pointing into the private network** — the SSRF
  guard from `@crewhaus/tool-fetch` runs on every hop, with the connection
  pinned to the IP it validated, so a registry cannot answer a manifest request
  with `302 Location: http://169.254.169.254/…`;
- **paging that leaves the registry's origin**, because a `Link` header is
  server-controlled and the alternative is being walked onto another host;
- **`withDigests` over its fan-out cap**, with the instruction to narrow, rather
  than quietly crawling somebody's registry;
- **a reference that is neither a tag nor a digest**, checked at the one place a
  string becomes a URL path. A tag list is server-controlled data, and
  `https://reg/v2/owner/app/manifests/` + `../../victim/manifests/latest`
  normalises to a different repository — whose digest would then be reported as
  this one's. Entries outside the tag grammar are dropped from a tag list and
  counted as `malformed` rather than carried; a registry host with a port above
  65535 is refused by name instead of by a URL parser.

A pull token is also dropped the moment a redirect leaves the origin it was
minted for. Registries redirect to CDNs and object stores; forwarding the token
hands it to whoever runs them.

## Tag lists are not semver, and are sorted anyway

A real repository holds `latest`, `edge`, `sha-9f3c1a`, `0.6` and `v1.0.0-rc.1`
side by side. The default sort partitions: versions first by semver precedence,
newest first, then everything else in lexicographic order. No *tag* is dropped
and nothing throws — an unparseable version is still a tag, not an error.
`1.0.0-alpha.10` sorts above `1.0.0-alpha.2`, because those identifiers are
numbers.

`match` is a glob over tag names with `*` and `?`. It is matched with a
two-pointer scan rather than a compiled regex: `*` as `[^]*` makes
`*a*a*a*a*a*a*a*a*z` cost C(n, 8) backtracks against an n-character tag, which
for a full-length 128-character tag is hours of CPU inside one synchronous
`RegExp.test` — where neither `timeoutMs` nor a cancellation signal can reach
it, since both only take effect between awaits.

`withDigests` resolves each returned tag with a GET and verifies it, rather than
a HEAD: a `HEAD` gives you the registry's claim about a digest and no bytes to
check it against, which is the one thing this package will not report. The limit
is applied before the fan-out, never after.

## What it does not do

- **It does not pull.** Layers are never fetched; only the manifest and, on
  request, the image config blob.
- **It does not authenticate.** Anonymous flow only — no credentials are read,
  stored or sent, and a private repository is refused.
- **It does not echo environment values.** A config blob is where a careless
  build leaves a token, so `envNames` lists the names and drops the values.
- **It does not sort by creation time.** That would cost a manifest plus a
  config blob per tag to order a list, and the answer would still be the time a
  config was built rather than the time a tag was pushed.
- **It does not invent a total.** `totalLayerSize` sums the layer descriptors
  that carried a `size`; when any did not, `unsizedLayers` says how many, so the
  number is read as the floor it is.
- **It does not cache.** The token lives in the call that earned it and dies
  with it; a second call asks the registry again and gets today's answer.
