# @crewhaus/tool-state

Durable state for a harness, and lexical retrieval over it. A directory of
small files under the workspace — no database, no server, no network, nothing
to run alongside the harness.

A context window forgets. A crew does not get to: it has to know what it has
already handled, how many attempts are left, where the last run got to before
it was killed, and what the other agent found out an hour ago. These twenty
tools are that memory, and a model spends no tokens deciding any of it.

The package exports each tool and the frozen `STATE_TOOLS` list a catalog
registers. There is **no `all-state` category yet** — `@crewhaus/tool-categories`
does not know this package, so a spec names the tools it wants:

```yaml
tools:
  - kvGet
  - kvSet
  - journalAppend
```

| Tool | What it does |
|---|---|
| `KvSet` | Store a JSON value under a key, with an optional TTL and compare-and-set |
| `KvGet` | Read one key back, with its version and expiry |
| `KvDelete` | Delete a key, optionally only at the version you read |
| `KvList` | List a namespace, sorted, with versions and optionally values |
| `CounterIncrement` | Add to a durable counter, optionally refusing to cross a limit |
| `CounterGet` | Read one counter, or every counter |
| `CheckpointSave` | Save a named JSON checkpoint as a new numbered version |
| `CheckpointLoad` | Load the newest version, or an earlier one by number |
| `CheckpointList` | What there is to resume from, with version counts and labels |
| `JournalAppend` | Append to an append-only JSONL stream with a monotonic sequence |
| `JournalRead` | Read a stream back by sequence range, kind or substring |
| `BlackboardPost` | Leave a note for the rest of the crew under a topic |
| `BlackboardRead` | Read a topic, by author, tag, sequence, or latest-per-author |
| `NoteWrite` | Write a durable note with a title and tags |
| `NoteSearch` | BM25 ranked search over the notes |
| `IndexBuild` | Build an inverted index over a list of workspace text files |
| `IndexSearch` | Query that index and get the ranked files, with optional snippets |
| `StateExport` | Dump the whole state directory as one JSON document |
| `StateImport` | Restore it, merging or replacing, with a dry run first |
| `DedupeMark` | Record that an external id was handled, and say if it already was |

Everything lives under `.crewhaus/state` in the workspace by default; every
tool takes `stateDir` to point somewhere else, and that path is contained the
same way (see **Containment**).

There is one more tool, and it is not one of the twenty — see
**[VectorDelete](#vectordelete-the-one-tool-that-leaves-the-workspace)**.

## The four properties

**Containment.** Every caller-supplied path — the state directory, and the
file list `IndexBuild` is given — goes through the same `resolveSafe` gate as
`@crewhaus/tool-fs` and `@crewhaus/tool-fsx`: nothing may resolve outside
`process.cwd()`, including via a symlink that lives inside the workspace and
points out of it. Every path *beneath* the state directory is checked the same
way, against its real location and not just its spelling, because the escape
that works in practice is not `../..` — it is an ordinary-looking `kv/cache`
that happens to be a symlink to `/tmp`. A dangling symlink is refused too: an
append would otherwise follow it and create the file it points at. Keys, ids
and topics never become path segments; they are percent-encoded into a single
filename, so a key of `../../etc/passwd` is a file called
`%2e.%2f..%2fetc%2fpasswd`, not a traversal.

`StateImport` in `replace` mode deletes a directory the caller names, so it
refuses any directory that holds anything this package did not put there —
and the workspace root always. `mode: "merge"` is the way to write into a
directory that is not ours.

**Determinism.** Same inputs against the same state, same bytes out. Listings
are sorted by plain code-unit comparison — never `localeCompare`, whose order
depends on the machine's locale. Nothing samples a random source. And **no
tool reads the clock**: every timestamp and every TTL is computed from a `now`
you supply, so a TTL is reproducible, a result can be replayed, and a stored
record contains no timestamp at all unless you asked for one. A `now` with no
offset (`2026-01-02T03:04:05`) is read as **UTC**, not in the machine's zone,
which ECMAScript would otherwise do — the same input has to mean the same
instant on a laptop and on a CI runner.

**Tolerance.** A killed process leaves half-written files. Every read here
reports `missing`, `corrupt` or over-size as a normal result, naming the file
and the reason: one bad record does not fail a listing, one truncated line
does not fail a journal read, and a lost sequence hint is rebuilt from the log
itself. Reads are bounded in memory, not merely checked beforehand, and
anything that is not a regular file is refused rather than read — a FIFO stats
as empty and would block the call for ever. Nothing throws out of `execute`
because the last run died badly.

**Honest safety flags.** The ten writers are `destructive: true`; the ten
readers are `readOnly: true` and `concurrencySafe`. Every tool in `STATE_TOOLS`
is `scope: "internal"` and declares no `ioCapability`, because nothing in that
list opens a socket or spawns a process — `packages/tool-state/src/index.test.ts`
asserts it for all twenty, so a future tool that reaches outward cannot slip in
unlabelled. None of the twenty sets `requireJustification`, because none has an
outward side effect: they write to one directory the operator chose, and
`DedupeMark` exists precisely so that the tools which *do* reach outward are
called once.

That test is why `VectorDelete` is not in the list. It reaches a store the host
registered, which may be remote, so it declares `scope: "external"` with
`ioCapability: "network"` and does take a justification.

## Concurrency, precisely

Two agents in one workspace are the case this package is built for.

- **Compare-and-set** (`KvSet`, `KvDelete`, `CheckpointSave`): pass the
  version you read and the write is refused if it moved. `expectedVersion: 0`
  means "only if nobody has claimed this yet", which makes a key a lock.
- **Counters** and **sequence allocation** run their read-modify-write under a
  lock file with a 2-second deadline; a lock older than 30 seconds is treated
  as abandoned by a dead process and broken.
- **Journal and blackboard appends** use `O_APPEND`, so a writer that somehow
  bypassed the lock still cannot splice a partial line into somebody else's.
- **`DedupeMark`** needs no lock at all: the mark is an exclusive file create,
  so exactly one caller can win even under a retry storm.

The limits, stated plainly: the lock is **cooperative and machine-local**. It
does nothing about a process that ignores it, and nothing about two machines
sharing a state directory over NFS, where neither `O_APPEND` atomicity nor
lock-file exclusion is guaranteed. Sequence numbers are monotonic but **not
gapless** — an append that fails after its number was allocated leaves a hole,
so a sequence is an ordering, not a count.

## Search, precisely

`NoteSearch` and `IndexSearch` rank with Okapi BM25:

```
score(D,Q) = Σ_t  idf(t) · ( f(t,D)·(k1+1) ) / ( f(t,D) + k1·(1−b+b·|D|/avgdl) )
idf(t)     = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
```

`k1` (default **1.2**) sets how fast term frequency saturates; `b` (default
**0.75**) how hard a long document is penalised. Both are caller-tunable and
both are echoed in every result, so a ranking can be reproduced later. The
`+1` in the logarithm is the non-negative idf variant: the classic form goes
negative once a term appears in more than half the corpus, which perversely
penalises a document for containing a query term.

**It is lexical only.** No embeddings, no synonyms, no stemming, no stop-word
list — a document ranks because it literally contains the query's words, so a
note about "automobiles" will not answer a query about "cars", and "run" will
not match "running". That is the trade for a retriever that needs no model,
no vector store and no network, and that returns the same ranking every time.
When meaning matters, this is the cheap first pass and a model is the
escalation path.

`IndexBuild` takes an explicit list of paths — pair it with `Glob` or
`FindFiles` rather than duplicating a directory walker here. The index is a
snapshot and watches nothing; `IndexSearch` compares each hit's size and mtime
against the index and reports `stale` rather than pretending otherwise.

## VectorDelete, the one tool that leaves the workspace

| Tool | What it does |
|---|---|
| `VectorDelete` | Delete entries from the registered vector store by id, and say exactly how little can be known about the result |

It is exported, and listed in `VECTOR_TOOLS` — **not** in `STATE_TOOLS`. The
twenty above promise that nothing crosses a process or network boundary and a
test enforces that over the list's membership; a vector store may be a qdrant,
pinecone or weaviate collection over HTTP, so this one is labelled
`scope: "external"` with `ioCapability: "network"`, takes a justification, and
is kept out of a list whose meaning it would quietly dilute.

**It needs a store handed to it.** This package does not depend on
`@crewhaus/vector-store` and cannot build a store from a backend name; the host
registers the one it already built, the way `@crewhaus/tool-retrieve` is wired:

```ts
import { registerVectorTarget } from "@crewhaus/tool-state";

registerVectorTarget({
  store: vectorStore,          // any VectorStore — structurally typed, no import
  collection: "chunks",        // needed before a protection list can mean anything
  protectedCollections: ["audit"],
  countConsistency: "eventual", // optional; otherwise inferred from the backend
});
```

With nothing registered the tool refuses. It will not fall back to an empty
in-process store, which would let an erasure request come back as a clean
success having deleted nothing.

The registration is checked there and then, not at the first call: a store
missing `delete`/`count`, a `collection` that is not a usable name, a
`protectedCollections` that is not an array of names, or a `countConsistency`
that is neither word, each throws `VectorTargetError` at boot. Every one of
them would otherwise fail *open* — a bare string protection list reads one
character at a time and protects nothing it names, and an unrecognised
`countConsistency` used to make `countAfter` sound authoritative.

**What it will not claim.** The store interface exposes no `exists` and no
`get`, so per-id truth is unobtainable. The result therefore reports
`deletesAttempted` and `deletesAcknowledged` — acknowledged meaning the store
accepted the request — and carries `perIdOutcome: "unavailable"`. There is no
deleted/missing split anywhere in it, because there is no way to earn one.

`countBefore` and `countAfter` are two observations, never a measurement of
what was deleted. Between settling-then-recounting and saying so, this tool
**says so**: `countAfterIsIndicative` is true on every backend but the
in-process one. Settling would mean sleeping on the system clock, which no tool
in this package does, and a settle loop cannot tell "the backend has not caught
up" from "the delete did not land" — it would convert an honest unknown into a
confident wrong answer. A count that could not be read at all comes back as
`null` with the reason beside it, never as `0`.

**The gate runs once.** `protectedCollections` — the caller's, the
registration's and any `tool_config` block's (both spellings of the key, also
unioned), because a deny-list that could be narrowed by a later source is not a
gate — is checked before the
selection, before the first count, before the first delete. A refusal means the
store was never touched, which is the only way `dryRun` can promise anything
about a real run; the dry run runs the same selection code and predicts the
same refusal. Two fail-closed rules: a store registered with no collection name
refuses while a protection list is in play (it cannot be *shown* not to be the
protected one), and a name differing from a protected one only in case is
refused rather than guessed.

**Two limits worth knowing.** The collection name is asserted by the host at
registration; the store offers no way to confirm it, which `expectCollection`
mitigates but cannot remove. And containment does not reach through the seam:
if a host registers a lance store pointed outside the workspace, that is the
host's path, resolved by the store, not by this package's gate.

## What is deliberately not here

No server, no replication, no cross-machine coordination, no queue. No
eviction: an expired key is hidden from reads but its file stays until
something deletes it, because a tool that silently removed data on a read
would be a bad thing to have in a crash loop. No `NoteDelete` — notes are
overwritten by id, and removing one is a filesystem operation. No full-text
search over arbitrary trees: `IndexBuild` indexes the files you name.

## Layout

`src/lib/` holds the pure functions and is where the behaviour is tested
(`bm25.ts`, `jsonl.ts`, `names.ts`, `records.ts`); `src/store.ts` owns the
filesystem — atomic writes, locks, tolerant reads — and `src/index.ts` is a
thin wrapper that turns those into tools. `src/paths.ts` is the containment
gate: it started as a copy of `@crewhaus/tool-fsx`'s, and refuses everything
that one refuses, plus two cases this package's own layout needs — a dangling
symlink, and a symlink on an interior path beneath an already-approved root
(`resolveWithin`). `src/vector.ts` is `VectorDelete`'s seam — the structural
store interface, the registration, the selection and the two observations —
kept in its own file so the one tool that leaves the workspace is visible as
such, and so moving it to a package of its own is a file move.

## On disk

```
.crewhaus/state/
  kv/<namespace>/<key>.json        one file per key: value, version, expiry
  counters/<name>.json
  checkpoints/<name>/v0000001.json  numbered versions, newest last
  journal/<stream>.jsonl            append-only, plus a <stream>.jsonl.seq hint
  blackboard/<topic>.jsonl
  notes/<id>.json
  indexes/<name>.json               the serialised inverted index
  dedupe/<scope>/<id>.json
```

It is all plain text: `cat` it, diff it, commit it, or delete the directory to
start again.
