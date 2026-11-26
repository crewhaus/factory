# @crewhaus/attention

One inbox for every decision and problem across harnesses. Module brief
[331](https://github.com/crewhaus/docs/blob/main/module-briefs/331-attention.md).

Everything here is derived, read-only, from records other parts of CrewHaus already keep:

| Source | Becomes |
|---|---|
| tool approvals and questions in the harness's session root | `permission` and `question` items; requests that ask the same thing fold into one |
| `dec_` decisions | `standing-rule-proposal`, `quality-adoption`, `deploy-approval`, and `decision` for kinds no row claims yet |
| the review queue | `review` items |
| graph runs that say they wait (`pendingHitl` in a run's `_meta.json`) | `checkpoint` items, one per pause |
| the Advisor's findings, as Home last gathered them | `quality-regression`, `budget`, `security`, `spec` and `setup` items |
| failed runs in the run ledger | `credential`, `provider-limit`, `budget`, `spec` and `run-failures` groups |

An item's id is `att_` and the digest of what it is about, so the same evidence names the
same item everywhere; its `evidenceRev` moves only when its evidence does. Failed runs
group by cause: a credential the env chain supplies from one shared file, or one provider's
rate limit, groups runs across harnesses; everything else groups within one harness.

## Reads never mutate

Every file is read realpath-contained to its harness, from its newest end, under caps that
say when they cut a read short. A harness whose sessions folder lies outside it is
reported as unreachable and nothing under it is read. Nothing in `@crewhaus/attention`
writes, creates or compacts a file; acting is `@crewhaus/attention/act`.

## Acting: `@crewhaus/attention/act`

What a person does about an item, the same from Home, the API and `crewhaus inbox`. Each
act is planned first, reading only (`planResolve`, `planAssign`, `planDefer`, `planSnooze`,
`planDismiss`, `planAcknowledge`, `planReopen`, `planMessage`, …): a refusal has written
nothing, so a caller writes its receipt only for an act that runs.

A verdict settles the item through its source's own writer: the decision service for a
request or a `dec_`, the claimed review queue, one person's vote on a protected
environment's approval, a graph run's resume, an Advisor finding's own closed job. The
inbox settles nothing itself. A caller lends what only it has (`ActDeps`).

Every act that ran is one line on the harness's actions ledger
(`.crewhaus/run/control/attention/`): ids, closed codes and times, never text. The fold
reads those lines back as overlays, and `attentionEventOf` turns one into the
`attention.*` event its stream sends. An overlay assigns an item, puts it off, hides it
from one member or sets a problem aside; it never settles an item that waits on a record
of its own. A problem set aside comes back when its `evidenceRev` moves, saying it was set
aside before.

A discussion's messages are kept in `.crewhaus/run/attention/threads/<att>.jsonl`, `0600`,
for people: their text reaches no model, no ledger and no event.

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
must be in the closed vocabulary and not registered already.

`producer.fold` answers `{ key, item }` rows. The inbox serves what the registration may
add and no more: an item of the producer's own kind, about the harness that was read,
under a title the producer registered. The rest is dropped. Its ref is derived from its
kind and `key` (ids, names and digests only), a body reaches only a reader of the
harness's content, and a choice gives its command as `twin: { template, params }`, a
closed template the inbox fills in and quotes. A ready command string is never served.

## Testing

```
bun test packages/attention/src
```
