# @crewhaus/tool-pkg

Packaging, lockfiles and releases — the questions whose honest answer
requires reading a large mechanical file.

| Tool | Answers |
|---|---|
| `SemverResolve` | which versions satisfy a range, and which one an install picks |
| `LockfileDiff` | what a dependency bump actually changed |
| `LicenseAggregate` | what the installed tree declares, and what a policy forbids |
| `PackageTarballInspect` | what is really inside a package tarball |
| `PackagePublishPreflight` | what would break *after* publishing |

Each of these is otherwise answered by putting a lockfile, a tarball listing
or a few thousand tiny `package.json` files through a context window. The
tools read the files themselves; only the answer comes back.

## The two release tools answer different questions

`PackagePublishPreflight` reads the manifest and the source tree.
`PackageTarballInspect` reads what was actually packed. A package can pass
the first and fail the second — a build that did not run leaves `dist/` in
the manifest, in `files`, and out of the tarball — which is why both exist
and why the preflight says so rather than implying it is the last word.

Preflight is about mistakes that pass every test, because they are properties
of the published artifact rather than of the source:

- a `workspace:`, `file:`, `link:` or `portal:` range, which resolves inside
  the monorepo and means nothing to a registry client
- an entry point that no `files` entry covers — the file is there, the tests
  pass, and the tarball does not contain it
- a `.env`, `.npmrc` or private key sitting in the package directory
- `private: true`, a missing or malformed version

Blocking problems would break the published package. Warnings would only
embarrass it.

## Reading archives

`PackageTarballInspect` lists; it never extracts. That removes the whole
class of archive-extraction bugs — `../` traversal, absolute member names,
symlink members reaching outside the destination — because nothing is written
anywhere. Hostile member names are reported exactly as stored, flagged under
`suspicious`, rather than resolved or sanitized.

The reader handles what real archives contain: gzip or plain, ustar prefixes,
GNU long-name entries, pax extended headers, and base-256 numeric fields for
sizes and timestamps that do not fit in octal. Header checksums are verified,
so file data cannot be mistaken for a header; an archive that ends without
its terminator is reported as truncated rather than as complete.

Decompression is bounded at 1 GiB of output. A limit on the file size bounds
nothing — gzip of a repetitive stream runs a thousand to one, so a 200 KB
archive expands to 200 MB — and the limit that matters is the one zlib can
enforce while inflating rather than after.

## Licenses

`LicenseAggregate` reports what packages **declare**. It does not read
license texts, so a package declaring MIT while shipping something else is
reported as MIT.

SPDX expressions are treated the way they are written: `MIT OR GPL-3.0`
offers the consumer a choice, so a rule denying GPL does not fire; `MIT AND
GPL-3.0` imposes both, so it does. A deny prefix matches a family without
matching a lookalike — `GPL` does not match `LGPL-3.0`, which carries
different obligations.

It reports what is *installed*, so it needs `node_modules` to be there. When
it is not, it says so rather than returning zero packages and no violations,
which would read as an all-clear.

A `node_modules` entry is very often a symlink — that is how pnpm and the
workspace protocol work — so links are followed when they stay inside the
workspace and skipped when they leave it. The number skipped is reported, so
a tree that is mostly elsewhere does not look like a small clean one.

## Shared implementations

The semver grammar, the comparison and the four lockfile parsers come from
`@crewhaus/tool-code`, which already reads them for `DependencyList` and
`DependencyOutdated`. Two implementations of "does this version satisfy this
range?" would disagree at the edges — prerelease ordering, `^0.x`, wildcard
forms — and a harness would get one answer from one tool and another from the
next.

## What it does not do

- **It does not reach a registry.** No npm metadata, no search, no changelog
  fetch, no container registry. Everything here is local.
- **It does not write.** No manifest edits, no version bumps, no publish.
- **It does not resolve a dependency tree.** `SemverResolve` answers about one
  range against a list of versions you supply; it is not an installer.
- **`wouldInclude` approximates npm's packing rules.** npm layers
  `.npmignore`, `.gitignore` and a set of always-included names on top, so a
  clean preflight is not proof — `PackageTarballInspect` on real `npm pack`
  output is.
