# @crewhaus/tool-work

Work items: what a harness was asked to do. Module brief:
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

## `./work-items`

The store (`openWorkStore`), the one proposal object (`parseAssessment`, `checkProposal`),
the one ranker (`rankWork`, corrected by a person's example scoped to the item, similar
items or all), the display state (`effectiveWorkState`) and the Work feed (`workFeed`).
Reads take no lock and write nothing.
