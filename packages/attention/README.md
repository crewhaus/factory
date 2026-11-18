# @crewhaus/attention

One inbox for every decision and problem across harnesses. Module brief
[331](https://github.com/crewhaus/docs/blob/main/module-briefs/331-attention.md).

Everything here is derived, read-only, from records other parts of CrewHaus already keep:

| Source | Becomes |
|---|---|
| tool approvals and questions in the harness's session root | `permission` and `question` items; requests that ask the same thing fold into one |
| `dec_` decisions | `standing-rule-proposal`, `quality-adoption`, and `decision` for kinds no row claims yet |
| the review queue | `review` items |
| the Advisor's findings, as Home last gathered them | `quality-regression`, `budget`, `security`, `spec` and `setup` items |
| failed runs in the run ledger | `credential`, `provider-limit`, `budget`, `spec` and `run-failures` groups |

An item's id is `att_` and the digest of what it is about, so the same evidence names the
same item everywhere; its `evidenceRev` moves only when its evidence does. Failed runs
group by cause: a credential the env chain supplies from one shared file, or one provider's
rate limit, groups runs across harnesses; everything else groups within one harness.

## Reads never mutate

Every file is read realpath-contained to its harness, from its newest end, under caps that
say when they cut a read short. A harness whose sessions folder lies outside it is
reported as unreachable and nothing under it is read. Nothing here writes, creates or
compacts a file.

## Two ways to the same items

`attentionProjection(facts)` is the read model Home's projector keeps; `foldHarness` folds
the same model on the spot when there is none. Both end in `harnessAttention`, so they give
the same items. `assembleInbox` merges several harnesses into one list: groups across the
harnesses given (pass only the ones the caller may read), decide before fix before
consider, newest evidence first.

The env chain arrives through a facts port (`HarnessFacts`), so this package never reads an
env file and never sees a value; a tool input is a `body`, read at serve time for a caller
who may read the harness's content, and never kept in the saved model.

## The Advisor's findings

No read gathers them: Home's sweep does, a few harnesses a minute, and keeps each harness's
findings in its own index (`readAdvisorSnapshot`, `withAdvisorSnapshots`). A snapshot keeps
ids, severities, screens, actions and evidence times, never the Advisor's prose. A harness
Home has not checked yet is named in the list's `advisorUnchecked`.

## One list, for Home and the terminal

`attentionListBody` is the page Home's `attention.list` answers and `crewhaus inbox list
--json` prints: the items, the harnesses that could not be read (named whether or not
anything is listed), each mentioned harness's name, and why an empty list is empty.
`sentenceOf` turns a closed text id into the words a terminal prints.

## Producers

Another area adds items of its own kinds with `registerProducer(kind, producer)`. The kind
must be in the closed vocabulary and not one of this package's own.

## Testing

```
bun test packages/attention/src
```
