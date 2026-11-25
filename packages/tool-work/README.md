# @crewhaus/tool-work

Work items: what a harness was asked to do, and their delivery as pull requests. Module brief:
[333-tool-work](https://github.com/crewhaus/docs/blob/main/module-briefs/333-tool-work.md).

A work item (`wi_…`) is a content-free log line per event under `.crewhaus/run/control/work/`
and an immutable content revision per change under `.crewhaus/run/control/work/items/<wi>/`,
each text field recording the origin it came through. Items move `proposed → open → closed`
and reopen.

## The tools

| Tool | readOnly | destructive | What |
|---|---|---|---|
| `WorkList` | yes | no | the items, with their status in words and their place in the ranking |
| `WorkGet` | yes | no | one item: what was asked, done-when, why, notes, runs |
| `WorkPropose` | no | no | a proposal with its assessment; the same source is one item |
| `WorkUpdate` | no | yes | a note, a linked run, a delivery, an edit of its own proposal, or a close with a reason |

A spec gets them by listing them (`tools: [workList, workGet, workPropose, workUpdate]`).
They propose, add notes, link runs and close with a reason. They never accept, decline or
cancel, never rewrite an accepted item, and never claim an operator's or an API caller's
source.

One `WorkUpdate` call is one write: every part is checked first (a close's legality
included), so a refused call writes nothing and a retry writes nothing twice. An item keeps
at most 100 notes and 100 deliveries, and notes and deliveries together stop short of the
content size limit, so a person can always still edit the item.

`WorkList` and `WorkGet` classify the text they return inside the tool, field by field, at
the origin each field was written through (`api`, `memory`, `mcp`), and then the fields of
one origin side by side. They set `classifyOutput: false`, so the same text is not classified
again as a tool result.

The work list belongs to the harness and to Home's own runs: inside a managed tenant's run,
the four tools refuse before they open the store.

## `tool_config.work`

```yaml
tool_config:
  work:
    accept: [fix, maintenance]   # kinds the runtime may accept on its own
    ranking:
      weights: { evidence: 3, cost: 2, fit: 1 }   # each 0 to 10
```

`accept` never accepts a feature, or a proposal of any kind whose basis is speculative, with
nothing observed: it waits for a person. Evidence counts as observed only when this harness's
own records hold what it names: another run of this harness (`run_…`), a session of this
harness (`session:<id>`), or a work item a person or the system adopted from a Thredz task or
a GitHub issue (`wi_…`). A label alone never counts, and neither does a reference to the
proposing run, the run it continues, or their sessions. Without
`ranking.weights`, items rank by priority, then age. Every leaf under `tool_config` is out of
the optimizer's reach.

## Delivering work as pull requests

| Tool | readOnly | destructive | scope · io | What |
|---|---|---|---|---|
| `WorkspaceOpen` | no | no | external · network | a worktree for an accepted item, on its own branch |
| `WorkspaceCheck` | no | yes | external · process | the repository's declared checks, in the sandbox |
| `WorkspacePublish` | no | yes | external · network | the change as one pull request, after every check |

A spec lists them by name on `cli`, `workflow`, `channel`, `managed` or `batch` and declares
where they deliver:

```yaml
repositories:
  app:
    host: github
    repo: acme/budget-app
    checks: [[bun, install, --frozen-lockfile], [bun, test]]   # argv, never a shell
    pull_requests: { draft: true, max_files: 20, max_lines: 800, require: [checks, acceptance] }
tool_config:
  codehost:
    token_env: GITHUB_TOKEN     # the variable that holds the token: a name, never a value
```

- **One managed clone per repository**, `.crewhaus/workspaces/<binding>/repo`, and a worktree
  per item (`…/wt/<name>`) on a branch minted once from the item. The harness keeps working
  from its own directory; the tools point at the worktree. Each binding's git directory is on
  the runtime-state floor, so an agent's file tools cannot write it.
- **The token reaches one git process.** Every fetch and push gets it as one
  `http.<origin>/.extraheader` entry in that process's environment, for the code host's origin
  only: never in argv, a URL or a file. Nothing inherited configures git, no hook runs, and a
  clone whose own configuration holds a key git did not write gets no token.
- **Checks run in the sandbox** (`CREWHAUS_SANDBOX`), with the worktree mounted and no network.
  Without a sandbox `WorkspaceCheck` is refused and runs nothing, and a publish that requires
  checks is not made.
- **Before a pull request opens**, in order: the size limits (a larger change waits for a
  person's decision, with the counts), the base (rebased onto, and checked again), the checks
  for that exact commit, what leaves (a credential of the harness, a credential-shaped token,
  or text from a source whose words do not leave in a commit refuses it, naming the file and
  the line), and the acceptance check: deterministic criteria first (`check: <name>`), then a
  judge over the item's criteria and, when the spec declares one, its `intent:`. The judge's
  reasons stay in a private file beside the check logs; the pull request and the agent get the
  verdict as a word.
- **One pull request per item.** The branch is pushed under a lease, and the pull request is
  found by its branch before one is made, so a retry updates it. An attempt whose answer was
  lost is `unknown` until it is looked up; it is never made a second time.
- **The tracker** (`syncOutcomes`, run by Home every ten minutes) reads each delivered pull
  request: merged closes an open item as done, closed without merging declines it, reopened
  reopens an item the tracker declined, and a revert of the merge is recorded. An item a person
  moved stays where they put it.

`work.publish` (Home's API, `crewhaus work publish <wi>`) publishes only a change a run of the
harness judged and passed for the same commit, with the harness's own environment files.
`crewhaus workspace list|show` reads the records.

## `./workspace`

The engine (`createWorkspaceEngine`), the boot registrar (`bindWorkspaceRepositories`), the
acceptance check, what may leave, the tracker (`syncOutcomes`, `applyPullEvent`), the views
Home and the CLI read, and `networkGitEnv`, the one way a token is handed to git.

## `./work-items`

The store (`openWorkStore`), the one proposal object (`parseAssessment`, `checkProposal`),
the one ranker (`rankWork`, corrected by a person's example scoped to the item, similar
items or all), the display state (`effectiveWorkState`) and the Work feed (`workFeed`).
Reads take no lock and write nothing.
