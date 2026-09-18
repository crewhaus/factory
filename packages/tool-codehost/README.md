# @crewhaus/tool-codehost

GitHub and GitLab over their REST APIs, without a model turn per request.

An agent working on a repository spends most of its calls asking the same few questions: what
does this PR touch, which check failed and why, what did the reviewer object to, is there API
budget left before the fleet job stalls. Each one is a deterministic lookup with a stable answer.
Each one here is a single call that returns a normalised record instead of six kilobytes of host
JSON.

Twenty-six tools: seventeen read, nine write.

## The four commitments

**The token is a NAME, never a value.** `tokenEnv` names an environment variable — or
`token_env` in the `tool_config` block. The token is read at call time, attached as a request
header, and scrubbed out of every string on the way back. It never appears in a path, a query
string or a body, and a server that echoes it into its own payload gets it redacted out of the
record. There is an explicit test for that, driven by a fixture that deliberately leaks. The
field most likely to receive a pasted secret is the one whose name ends in `Env`, so a value
there that is not shaped like a variable name, or that carries a known token prefix, is refused —
and the refusal does not quote what it refused.

**The gate is fail-closed.** An empty origin allow-list denies everything, `api.github.com`
included. Every redirect hop is re-checked against the allow-list and the SSRF classifier, the
classification is numeric rather than a string prefix, the vetted IP is pinned for the connection,
and the token is dropped the moment a redirect crosses an origin. This is `@crewhaus/tool-http`'s
posture, carried over rather than re-derived.

**Nothing runs unbounded.** Every call has a deadline, and it covers the name resolution too:
`node:dns` takes neither a timeout nor an `AbortSignal`, so a wedged resolver is the one thing
that could hold a call open past the deadline meant to bound it. Every response is read under a
byte cap that bounds memory rather than just output, and every listing is bounded by a page cap
as well.

**Determinism.** Same inputs against the same world state, same bytes out. Listings are sorted
explicitly, comparisons are locale-free, nothing is random, and no result carries a wall clock the
caller did not ask for. Search is the one deliberate exception — the host's relevance order *is*
the answer — and it is an `order` option, spelled out in the description.

## Configuration

```jsonc
{
  "tool_config": {
    "codehost": {
      "allowed_origins": ["https://api.github.com"],
      "base_url": "https://api.github.com",   // optional; per-host default otherwise
      "token_env": "GITHUB_TOKEN",            // the NAME of the variable
      "host": "github"                        // default dialect
    }
  }
}
```

A self-hosted instance is reached by allow-listing it and pointing `base_url` at its API root
(`https://ghe.example.com/api/v3`, `https://gitlab.example.com/api/v4`). Nothing else changes.
It has to be a *root*: every request path is appended to it as text, so a base URL carrying a
query string or a fragment is refused rather than accepted — `https://host/#` would otherwise
send every call to `/` and return the answer as if it were the resource you asked for.

One caveat worth knowing before a CI-log call: GitHub serves job logs by redirecting to a storage
origin. That origin has to be allow-listed too, or `WorkflowRunLogs` is refused by name — which is
the correct outcome, just one that is easier to fix when you were expecting it.

## The tools

### Read — `readOnly`, `scope: "external"`, `ioCapability: "network"`

| Tool | What it answers |
|---|---|
| `PrList` | open/closed/merged pull requests, filtered by branch |
| `PrGet` | one PR with mergeability and a check summary |
| `PrFiles` | the files it touches, with capped patches |
| `PrComments` | the conversation, oldest first |
| `PrReviews` | who approved, who objected, and the inline threads |
| `IssueList` | the backlog, with the PRs GitHub mixes in filtered out |
| `IssueGet` | one issue with body and comments |
| `CheckRuns` | the checks on a ref, with the failing step named |
| `WorkflowRuns` | CI runs for a branch or sha |
| `WorkflowRunLogs` | the actionable excerpt of a failed run's log |
| `ReleaseList` / `ReleaseGet` | releases and their assets |
| `RepoGet` | default branch, visibility, topics, sizes |
| `SearchCode` / `SearchIssues` | the host's search, paginated |
| `CompareRefs` | the commits and files between two refs |
| `RateLimitStatus` | remaining quota — the tool that stops a fleet job burning its budget |

### Write — `destructive`, `requireJustification`

`PrCreate`, `PrUpdate`, `PrComment`, `PrReviewSubmit`, `IssueCreate`, `IssueUpdate`,
`IssueComment`, `ReleaseCreate`, `WorkflowRunRerun`.

Every one of these is publicly visible under the token owner's name, which is why they all carry
both flags. None of them declares its own `justification` property: the runtime injects a required
one, and a self-declared optional one would quietly take over that contract.

**Deliberately absent:** merging a pull request, and deleting anything. Both are irreversible and
belong behind a human.

## What this package does not do

A tool that overstates its coverage is worse than one that is narrow and says so, so:

- **GitLab is supported, not simulated.** It has no review object — approvals become approved
  reviews and discussions become threads — and **no request-changes state at all**, so
  `PrReviewSubmit` refuses that event rather than downgrading it to a note nobody would treat as
  blocking. Its API takes numeric user ids for reviewers and assignees, so those fields are
  GitHub-only here and are refused rather than silently dropped.
- **Line counts.** GitHub states them; GitLab does not, so for GitLab they are counted from the
  diff and marked `countsDerived`.
- **Label lists.** GitLab takes labels as one comma-separated string, and so does GitHub's label
  filter. A label whose own name contains a comma is refused there rather than quietly sent as
  two labels.
- **Host caps are passed through, not hidden.** GitHub lists at most 300 files per PR, omits the
  patch for very large files, and returns at most 250 commits from a compare. `PrFiles` and
  `CompareRefs` say so in their descriptions.
- **Code search.** GitHub's covers the default branch of indexed repositories and wants a
  qualifier in the query. GitLab's blob search here is project-scoped, because a group- or
  instance-wide one needs Advanced Search; it says so when you ask without a project.
- **Rate limits.** GitHub has a real endpoint. GitLab does not, so the tool makes one cheap
  request and reads the `RateLimit-*` headers off it — and an instance with rate limiting disabled
  honestly reports nothing.
- **Check steps.** GitHub Actions checks get their failing step named, by looking the job up.
  Checks published by other apps report only what the app published, and GitLab statuses carry no
  step list at all.
- **No merging, no deleting, no asset uploads, no line-level review comments, no GraphQL.**

## Layout

```
src/lib/refs.ts    validation + encoding for anything that becomes part of a URL
src/lib/page.ts    Link-header and x-next-page pagination, RateLimit headers
src/lib/shape.ts   one record shape per concept, from two hosts' payloads
src/lib/logs.ts    the actionable excerpt of a CI log
src/net.ts         allow-list, SSRF gate, deadlines, capped reads, redaction
src/api.ts         one request, one paginated listing, the base-URL rule
src/index.ts       the tools
```

`src/lib` is pure and tested in `src/lib.test.ts`. `src/index.test.ts` drives every tool at a real
`Bun.serve` on 127.0.0.1 that impersonates both APIs; `src/integration.test.ts` drives them through
`executeTool`, the way the runtime does, including a per-candidate `tool_config` block.

No tool here takes a filesystem path, so there is no path-containment module: the equivalent rule
for this package lives in `src/lib/refs.ts`, which is what keeps a caller's string from becoming
an extra path segment in an API URL. (A `src/paths.ts` came with the package scaffold and was
removed — unused containment code is code nobody tests and somebody eventually trusts.)
