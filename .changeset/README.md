# Changesets

This folder is hydrated by [changesets](https://github.com/changesets/changesets) — a per-PR queue of version-bump intentions across the `@crewhaus/*` workspace packages.

## How to use

After making a change to one or more packages, run:

```bash
bun x changeset
```

The interactive prompt asks:

1. **Which packages bumped?** Pick by space-bar.
2. **What kind of bump?** `patch` (bugfix), `minor` (new feature, backwards-compatible), `major` (breaking change).
3. **Summary** — one-line description that lands in `CHANGELOG.md` on release.

The tool writes a markdown file to this directory. Commit it alongside your PR. Multiple changesets per PR are fine; they aggregate on release.

## How releases work

When the changeset queue is non-empty on `main`:

```bash
bun x changeset version   # consume the queue, bump package versions, regenerate CHANGELOG.md
bun x changeset publish   # publish each bumped package in dependency order
```

Both commands are usually wired into a `release` workflow under `.github/workflows/`.

## Initial release notes

All packages were initialized at **v0.1.1** on 2026-05-30 — the project's first published API surface. (A v0.1.0 cut earlier the same day shipped with broken `workspace:*` → `0.0.0` dependency ranges and is left on the registry as a tombstone; consumers should pin `^0.1.1` or newer.) Pre-1.0 we follow these conventions:

- **Breaking changes** bump the minor (e.g. 0.1.x → 0.2.0) per the [npm semver convention](https://semver.org/#spec-item-4).
- **Features and bugfixes** bump the patch (0.1.0 → 0.1.1).
- **1.0.0** ships when the public API is judged stable enough that breaking changes become rare.

Until the `@crewhaus` npm scope is moved to public access, releases publish with `publishConfig.access: "restricted"` — i.e. into the private side of the scope on npmjs.com. The `--access public` flip happens scope-wide via `npm access public @crewhaus/<pkg>` (or by editing `publishConfig.access` and republishing) on the launch day cut described in `../PACKAGES.md`.
