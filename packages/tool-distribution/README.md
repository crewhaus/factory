# @crewhaus/tool-distribution

The four files a release publishes, and whether a published one is telling the
truth.

| Tool | Answers |
|---|---|
| `PackageManifestGenerate` | what the Homebrew, Debian, scoop and winget files for this release should say |
| `PackageManifestVerify` | is what they already say actually true |

A release binary reaches people through package managers, and each one wants a
small file that says *download this, check it against this sha256, then run it*.
Getting one of those four wrong is not a typo — it is either an install that
fails for a whole platform, or a binary installed without being checked.

## Generate renders nothing itself

`@crewhaus/single-binary-cli` owns the four renderers. Their output is pinned
byte-for-byte by goldens in that package, because those bytes ship to brew, apt,
scoop and winget on every real release. This tool consumes them through the
`ProductIdentity` parameter they were given for the purpose, and adds the
schema, the validation and the refusals around them.

So one call produces four files that cannot disagree with each other about a
version or a checksum, and the assets it reports are read back out of the
rendered text with the same reader `PackageManifestVerify` uses — not
re-derived from a URL template that would be the second copy to drift.

```
PackageManifestGenerate {
  version: "1.2.3",
  homepage: "https://crewhaus.ai",
  downloadBaseUrl: "https://github.com/crewhaus/factory/releases/download/v1.2.3",
  sha256: { "macos-arm64": "…", "macos-x64": "…", "linux-arm64": "…",
            "linux-x64": "…", "windows-x64": "…" }
}
```

`manifests: ["debian"]` renders one of them, and then only the shas that one
actually needs — the Debian control paragraph needs none, the formula needs
four. `product: {…}` renders for something that is not crewhaus.

## Verify keeps three outcomes apart

This is the part that matters most. Fetching an asset and hashing it can end in
three genuinely different places, and the result never folds them together:

| Outcome | Means |
|---|---|
| `missing` | the host answered **404/410**. The asset is not there. Definite. |
| `mismatch` | the bytes arrived **in full** and hash to something else. Definite, and the loud one. |
| `unchecked` | **nothing was learned** — and `reason` says what happened |

The reasons are `dns`, `timeout`, `cancelled`, `cap`, `shortRead`, `refused`,
`transport`, `status`, `unreadable`, plus `notRequested` when downloads were
turned off, `malformedSha` when the manifest's own checksum is not 64 hex
characters, and `insecureScheme`, `privateHost`, `credentialsInUrl`,
`urlWhitespace` or `urlMalformed` for a URL that was never dialled.

A verifier that reports "could not reach it" as a hash mismatch gets a good
release blocked. One that reports it as verified ships an unverified release.
Neither is acceptable, so the verdict has three values too: `verified` (every
asset was fetched and every hash agreed), `failed` (something definite is
wrong), `incomplete` (nothing disagreed, but the check did not finish). A
definite failure outranks an unknown, and the unknowns are still listed.

Some defects no download can find. A file whose `version` line says 1.2.4
while its URLs point at the 1.2.3 binaries hashes perfectly — each URL really
does serve the build it names — and is still a release that installs 1.2.3 and
calls it 1.2.4, so a URL that names a different version is an error. A URL with
no version-shaped segment at all is `notFound` and says nothing either way,
because publishing a `latest/` path is unusual rather than wrong.

The same rule applies to the structural checks. A manifest whose format could
not be identified, a version field this reader could not find, a scoop hash in
an algorithm it cannot compute — each is reported as a check that could not be
made, never as one that passed.

## Downloads are streamed, never held

An installer is tens of megabytes; the crewhaus binaries are about 80 MB each.
Chunks go into an incremental sha256 and are dropped, so a verify run costs one
chunk of memory rather than the whole file. `maxBytes` (default 256 MiB) stops a
stream that will not end, and hitting it is `unchecked`/`cap` — never a
mismatch, because the hash of a prefix is a different number, not a
disagreement. A body that stops short of its own `Content-Length` is
`shortRead` for the same reason, and a 200 that delivered no bytes is
`unreadable` rather than a mismatch against `e3b0c442…`, the sha256 of nothing.

Every request goes through `@crewhaus/tool-fetch`'s SSRF guard with the
connection pinned to the address it validated, re-checked at every redirect hop,
and every hop must still be https. A release host that redirects the download to
`http://169.254.169.254/` is the attack, and a bare `fetch` would have followed
it.

## What it refuses

A tool that cannot say no is not finished. `PackageManifestGenerate` refuses,
with the reason:

- **a sha256 that is not 64 hex characters**, or that is missing for a target a
  selected manifest needs — named per manifest, because rendering only the
  Debian control needs no shas at all;
- **a sha256 key that is not a build target**, rather than ignoring it and then
  reporting the target it was meant to be as missing;
- **a version the Homebrew formula will reject**. The renderer's own check is
  anchored only at the start, so `1.2.3"` passes it and lands inside a Ruby
  string in a file `brew install` executes; the check here is anchored at both
  ends;
- **a download base URL that is not https, or that points into private address
  space** — including the `0177.0.0.1` and `::ffff:169.254.169.254` spellings,
  because the classifier parses addresses instead of matching their text. A
  manifest is a bearer instruction to download and execute; plain http lets
  anyone on the path choose both the bytes and the checksum beside them, and an
  internal host published to brew is a release nobody else can install;
- **a credential in a URL**, since these files are published — and
  `PackageManifestVerify` reports one inside a manifest it is handed, because
  `https://github.com@dl.attacker.example/…` reads as github.com to a human
  reviewing the diff and fetches from somewhere else;
- **a URL carrying a tab, a line break or any other control character.** The
  URL parser deletes those, so `new URL(raw)` describes one URL while the
  renderers publish another; the two have to be the same string;
- **a Debian description line that already carries its leading space.** The
  renderer adds the single space the control format requires, so a line that
  arrives with one is published doubly indented — which dpkg reads as verbatim
  text rather than as part of the wrapped paragraph;
- **text that would stop being what it is spliced into**: a quote, a backslash
  or `#{…}` in a value that lands inside a Ruby string, and a `: `, a leading
  indicator character or a trailing colon in one that lands in a YAML scalar.

Two things are said out loud instead of being fixed silently: a trailing slash
on the base URL is trimmed with a note, and an uppercase sha256 is lowercased
with a note. A `formulaClass` Homebrew would not derive from the filename gets a
note too, because `brew audit` is the authority there, not this tool.

## Testing

No test in this package opens a socket or resolves a name. `_setFetch` replaces
the whole dialling step — the SSRF check and the IP pin live below it — and
`_setDnsLookup` from `@crewhaus/tool-fetch` replaces the resolver. Both are
installed in `beforeEach`, the fetch one with a stub that throws if a test
forgets its routes, so a missing stub fails immediately instead of reaching the
internet and timing out.
