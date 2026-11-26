# @crewhaus/knowledge-index

One view of what a harness knows, for Home and `crewhaus knowledge`
([#520](https://github.com/crewhaus/factory/issues/520),
[#521](https://github.com/crewhaus/factory/issues/521),
[module brief 335](https://github.com/crewhaus/docs/blob/main/module-briefs/335-knowledge-index.md)).
A harness keeps knowledge in several stores: facts, articles, working memory, session summaries,
lessons, suggestions, datasets, documents. This package projects them into one item model, one
search index that can be rebuilt at any time, and one fold of which runs used what. Each store's own
library stays the only writer of its bytes.

It never enters a compiled harness, and a test fails if an emitter, the runtime or a package they
reach names it. No model is called.

```ts
import { buildShard, readItems, search } from "@crewhaus/knowledge-index";

const harness = { harnessDir, hrn, hangarRoot };
const page = await readItems({ ...harness, canReadContent: true });
await buildShard(harness); // the only write, under Home's cache
const found = await search({
  q: "refunds type:fact since:30d",
  harnesses: [{ hrn, dir: harnessDir, name: "support" }],
  hangarRoot,
  canRead: (hrn) => mayRead(hrn),
  canReadContent: (hrn) => mayReadContent(hrn),
});
```

## Reads

| Function | What it answers |
|---|---|
| `readItems` | a page of one harness's items, with counts by store |
| `readItem`, `readHistory` | one item read from its own store, and what it was before |
| `search` | hits across the harnesses the reader may read |
| `lookup` | what became of the items a run used |
| `foldUsage` | the runs that used an item, and what one run used |
| `knowledgeIndexEffect` | whether the index reflects the stores as they are now |

Reads never write. With an index they open its files and compare a few file times; a hit from a store
that changed since is marked stale and read again, only that hit. Without an index one harness is
folded in memory, and a search of several looks at names and says so. Every file is opened inside its
own directory, and a link in a store's place is not followed.

An item's id is `<store>~<spec>~<partition>~<localId>[@<version>]`
(`@crewhaus/control-contract/knowledge`). Each item says what can be done with it, why not when it
cannot, and the command that does it.

## What an answer leaves out

- A harness the reader may not read adds nothing: it is left out before anything is ranked, counted,
  faceted or cut. Within a harness, each reader is ranked only against what they may get, so what
  they may not get moves no score they see.
- Without content permission a fact, whose title is its text, is in no answer; other items show a name
  and no text.
- A fact marked personal is in no search, and its row in the index holds no text, tag or
  conversation. A list of its own harness shows that it is there, so its owner can erase it.
- A customer's memory answers only a search of its one harness, by a reader who may read content.
- A preference file is not an item at all.

## The index

`<hangarRoot>/cache/index/knowledge/<hrn>/` holds `meta.json`, `items.jsonl`, `docs.jsonl`,
`postings.json`, `usage.json` and `epoch`, each 0600. Previews are at most 280 characters, and what
looks like a credential is masked. Two builds of the same stores are the same bytes apart from when
they were made, so the directory can be deleted at any time. An index names the folder it was built
from, and a harness reads no index built from another folder under its id. Past 50,000 items an answer says that the
index cannot list everything.

## Usage

A usage line names its item by a digest under the harness's own key, so only that harness's items can
be joined. What is not on record is said so: an item is `recorded: false`, and a run is `not-recorded`
because there is no usage log, because lines that old were removed, or because no line names it. It
shows what was in a run's context, not why a decision was made.

## Erasure

`@crewhaus/knowledge-index/erasure` is the one door through which CrewHaus's commands delete what a
harness knows about a person. Everything else a harness knows keeps its history, so the door acts only
on facts marked personal.

1. `planErasure` lists what would go and what would stay, and writes nothing. A fact's target is its
   whole correction chain, live and archived, its copies in the shared store and in the other
   registered harnesses, and, with its sources, what its conversation left behind. A copy is matched
   by what it says, never by a hash a record states. Shared stores are looked for where
   `knowledge sync` keeps them (`CREWHAUS_SHARED_DIR`, or a `.crewhaus-shared` folder above the
   harness) or where the caller names them, and a link at one of those names is not followed.
2. `authorizeErasure` asks that the caller may manage every harness the plan reaches, and that they
   typed the harness's name. It answers a grant: what each store may erase, by name.
3. `executeErasure` plans again and refuses when anything moved, runs each store's purge, removes the
   affected indexes, and appends one receipt to `.crewhaus/run/knowledge/erasures/` that holds counts
   and codes: no id, no hash, no text.

Each store's purge is on its own `./erasure` subpath and acts only on a grant that names its root and
its targets. A test holds that this package's erasure module is the only one that imports them.

## Testing

```
bun test packages/knowledge-index/src
```
