# @crewhaus/tool-registry

What the public registries know, and writing one answer back.

| Tool | Answers |
|---|---|
| `RegistryPackageInfo` | does this package exist, what is newest, is it deprecated |
| `RegistrySearch` | which libraries are candidates for this |
| `RegistryOutdated` | what has moved upstream since this manifest was written |
| `ManifestDependencySet` | write that version back without touching anything else |

npm, PyPI and crates.io, read anonymously over HTTPS. No token is sent, none
is accepted, and no private mirror is reachable — a name goes out and public
metadata comes back.

## Three constants, and no caller-supplied host

`@crewhaus/tool-fetch` and `@crewhaus/tool-codehost` spend most of their code
defending a URL a caller chose: an allow-list, an SSRF gate, an IP pin, a
redirect rule at every hop. This package does not accept a URL at all. The
caller supplies a package NAME, the name is checked against its registry's own
grammar, and the URL is built from one of three constants.

That makes `../-/user/org.couchdb.user:me` a refusal rather than a request,
and it makes the redirect rule short: a hop is followed only when it lands
back on one of the same three origins. Everything else — the SSRF check and
the connect-time IP pin, carried over from `tool-fetch` — lives in the default
dialler, which is what `_setRegistryFetch` replaces. That is why no test in
this package resolves a name or opens a socket.

## Absent means the registry does not publish it

The temptation in a normalizer is to fill the gaps, and every filled gap is a
number nobody measured:

- **npm's search has no download counts** and no sort parameter; it returns
  one relevance-ranked page. Asking for a downloads sort gets
  `sortApplied: false` and a note, not a re-sort of twenty results presented
  as a ranking of the registry.
- **PyPI has no search API.** The XML-RPC `search` was withdrawn in 2020 and
  `/search` is an HTML page with no contract. `RegistrySearch` refuses PyPI
  with that reason rather than scraping a page that will change.
- **A PyPI release with no files is not installable**, so it is not offered as
  a version an upgrade could pick.
- **crates.io publishes three "latest" fields** and they differ;
  `max_stable_version` is the one a caller adding a dependency means.
- `RegistryOutdated` reads npm's install-sized packument — the document npm's
  own installer reads — so its rows carry no publish dates. Ask
  `RegistryPackageInfo` for one package and you get the full document, dates
  included.

## Four range dialects, one evaluator

`@crewhaus/tool-code` owns `satisfies`, `parseSemver` and `compareSemver` for
this monorepo, and nothing here re-implements them. What this package adds is
the translation, because a Cargo requirement and a PEP 440 specifier only look
like npm ranges:

| Written | Where | Means |
|---|---|---|
| `serde = "1"` | Cargo.toml | `^1` — npm would read it as exactly `1.0.0` |
| `~=1.4.2` | a PEP 508 requirement | `>=1.4.2 <1.5.0` — npm has no `~=` |
| `==1.4.*` | a PEP 508 requirement | `1.4.x` |
| `requests = "^2.31"` | `[tool.poetry.dependencies]` | `>=2.31 <3.0.0` — PEP 440 has no `^` at all |
| `requests = "2.31"` | `[tool.poetry.dependencies]` | exactly `2.31`, not a floor |

**The dialect is a property of the declaration site, not of the registry.** One
pyproject.toml holds two: a PEP 621 `dependencies = ["requests>=2.31"]` array is
PEP 508, while every `[tool.poetry…]` table is Poetry's own caret/tilde grammar.
Read as PEP 440, `^2.31`, `~0.27`, `*` and a bare `2.31` — which is most of what
a Poetry project contains — all fail to parse, every row lands in `unchecked`,
and `outdatedCount` stays at 0. That is indistinguishable from "nothing to
upgrade" to anyone reading the number, which is why the table above is keyed by
where a spec was written.

Poetry's caret and tilde are expanded to explicit bounds rather than handed to
the shared `^`/`~` comparators, because those read every version as three
segments: `^0` would arrive as `^0.0.0` and pin the patch, and `~1` as `~1.0.0`
and pin the minor. The bound comes from the segments the author actually wrote.

Anything that does not translate exactly is refused with a reason and lands in
the `unchecked` list: PEP 440's `!=` and `===`, version epochs, hyphen ranges,
and every `workspace:`, `git:` or `file:` spec. A row in `unchecked` is never
counted as up to date, because "I could not evaluate this" and "this is fine"
are the two answers that must not be confused.

One trap is worth naming. `parseSemver` is deliberately unanchored so it can
read `1.2` and `v1.2.3` out of a lockfile — which means it also reads the PyPI
version `1.0rc1` as `1.0.0`, and a prerelease then compares EQUAL to its own
release. So versions are shape-checked before they are ordered, and a PyPI
version that is not plainly semver is reported as unorderable rather than
silently rounded.

## A write is a splice, or it is a refusal

`ManifestDependencySet` never reserializes. `JSON.parse` → `JSON.stringify`
reprints a package.json — indentation, key order, trailing newline — and the
diff of a one-character change becomes the whole file. A TOML round-trip is
worse: there is no comment-preserving TOML CST in this repository, and
parse-then-serialise is exactly the operation that drops the comments.

So the version string is located as a byte span and replaced. Everything
outside that span is untouched by construction. The locator handles the
spellings it can place exactly:

| Manifest | Spellings |
|---|---|
| `package.json` | `"dep": "^1.0.0"` in the four dependency sections |
| `Cargo.toml` | `dep = "1"`, `dep = { version = "1", … }`, `dep.version = "1"`, `[dependencies.dep] version = "1"`, including `[target."cfg(unix)".dependencies]` |
| `pyproject.toml` | the Cargo spellings under Poetry's tables, plus PEP 621 / PEP 735 requirement strings in `dependencies = [ … ]` |

and refuses the rest, by name and with the reason: a git, path or workspace
dependency that declares no version; a key declared twice; a multi-line
string; a `foo @ https://…` requirement; a list holding anything but plain
strings. **One refusal abandons the whole edit.** A partial write leaves a
manifest that is neither the old one nor the one that was asked for, and the
caller only finds out by reading the report carefully.

Three more rules the writer follows:

- **The result is re-read before it is written.** The spliced text goes back
  through the same locator, and every dependency must still be found, in the
  same section and spelling, reading as the new spec where it was edited and
  unchanged everywhere else. Splices are arithmetic on offsets, and this is
  the check that catches arithmetic being off by one — while the cost is still
  a refusal rather than a manifest.
- **A spec that could break out of its quotes never reaches the file.** No
  quote, backslash, `#` or control character; a version range needs none of
  them, and `1.0", "evil": "9` needs all of them.
- **The range style carries over only when it is unambiguous.** A leading `^`,
  `~`, `~=`, `>=`, `<=`, `==` or `=` on a plain version is reapplied to a plain
  new version. `>=1 <3`, `1.x`, `workspace:*` and `npm:alias@^2` have no single
  prefix to reapply, so the new spec is written verbatim and the result says
  `stylePreserved: false`. **An exclusive bound is never carried**: `<2.0.0`
  moved onto 2.5.0 would write `<2.5.0`, a range that excludes the version that
  was just requested, so the bound is dropped and the note says so.
- **A manifest that is not valid UTF-8 is refused.** The splice happens on the
  decoded text and is written back as UTF-8, so a byte the decoder could not
  represent would come back as U+FFFD — an edit to bytes nobody named, possibly
  nowhere near the version being changed.

## What it does not do

- **It does not install, resolve a tree or run a package manager.** After an
  edit the lockfile is stale on purpose; something else regenerates it.
- **It does not add or remove a dependency.** A name that is not already
  declared is a refusal, because adding one is a decision about the project,
  not a version bump.
- **It does not write go.mod, requirements.txt or a Gemfile.** Each is a third
  grammar, and a best-effort write into one is a corrupt manifest.
- **It does not retry.** A 429 comes back as a 429, with whatever
  `Retry-After` the registry sent, and the caller decides when to ask again.
- **It does not authenticate or reach a private mirror.** Both would put a
  caller-chosen host back in the dialling path.

## Neighbours

- `DependencyOutdated` in `@crewhaus/tool-code` compares a manifest against
  its own **lockfile** and never contacts a registry. `RegistryOutdated` asks
  the registry. Two different questions, which is why they are two names.
- `SemverResolve` in `@crewhaus/tool-pkg` resolves a range against a version
  list you already have. `RegistryPackageInfo` with a `range` resolves against
  the list the registry publishes.
