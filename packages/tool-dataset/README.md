# @crewhaus/tool-dataset

Four deterministic tools for the eval dataset itself: version it, inspect it, validate it, grow it.

| Tool | What it answers |
|---|---|
| `DatasetPut` | Write these samples as a new immutable version — without moving the rows that are already there |
| `DatasetInspect` | What is in this registry, and is it still what it says it is |
| `DatasetLint` | What is wrong with this dataset, offline, before an eval run pays for it |
| `DatasetMine` | Which recorded turns are worth adding, and which are already in the dataset |

No model call, no network, no subprocess. The logic is `@crewhaus/dataset-ops`,
`@crewhaus/dataset-registry` and `@crewhaus/eval-dataset`; this package is the schema, the
containment, the refusals and the result shape.

## The one piece of logic this package owns, and why

`DatasetPut` does not assign splits the way `crewhaus datasets put` does, because that assignment
is not stable under additions.

`splitSamples` orders samples by `sha256(id)` and cuts at the cumulative percentage boundaries.
The ordering is deterministic, but the **cut moves when the row count moves**, so adding rows
migrates existing rows across the boundaries. Measured against the shipped function (and asserted
in `lib.test.ts`, so it stays measured):

| Dataset | Rows added | Rows that changed split |
|---|---|---|
| 20 | +3 | 2 (one of them `test` → `dev`) |
| 50 | +1 | 1 (`train` → `dev`) |
| 100 | +5 | 1 |
| 1000 | +10 | 2 (one of them `dev` → `test`) |

Each of those breaks the lineage `tool-evalops` compares against, and a row that moves from
`train` into `test` is a holdout the optimizer has already seen.

The repair is deliberately **not** a second hash scheme (`hash(id) mod 100` would be stable and
would also mean the same dataset lands in different splits depending on which tool wrote it).
Instead:

- **`splitMode: "stable"` (default)** carries forward *what actually happened* — the split each id
  already sits in, read out of the previous version's record — and calls the package's own
  `splitSamples` for the new rows only. Existing rows cannot move because nothing recomputes them.
  Carried rows also keep their position inside the split, because the stored per-sample hashes are
  folded into the dataset hash in array order.
- **A first version** (no previous record) is assigned entirely by `splitSamples`, so a fresh
  dataset is byte-identical to what the CLI would have written.
- **`splitMode: "recompute"`** keeps the CLI's behaviour available and reports the rows it moved
  instead of moving them quietly.

Both modes run the **same** move detection, so `stable`'s empty `moved` list is a measurement, not
a claim the mode makes about itself. And a put that cannot *read* the previous version refuses
rather than writing a version whose lineage it cannot vouch for.

## Near-duplicate detection: the parameters set the recall, not the threshold

Two places ask "is this text already here", and they are bounded differently.

**`DatasetLint`** uses `@crewhaus/dataset-ops`'s own near-duplicate rule, which is exhaustive up to
its comparison cap (4,000,000 pairs ≈ 2,800 samples) and then *skips*. This package does not add a
second implementation with different verdicts; it reports the skip:

```json
"nearDuplicateScan": { "performed": false, "reason": "near-duplicate scan skipped: 3000 samples need 4498500 comparisons (cap 4000000)" }
```

and lists `near-duplicate-input` under `rulesNotEvaluated`. A short finding list on a large dataset
is never a clean bill of health.

**`DatasetMine`** compares each candidate against every sample in every version of a registry
dataset, which is an all-pairs problem a 50k-row registry makes unusable. It is blocked:

| Parameter | Default | What it controls |
|---|---|---|
| `tokensIndexedPerSample` | 4 | How many of each existing sample's *rarest* tokens are indexed (the banding width) |
| `maxPostingsPerToken` | 200 | A token in more samples than this is dropped as carrying no signal |
| `threshold` | `NEAR_DUP_THRESHOLD` (0.9) | Token-Jaccard at or above which a candidate counts as a duplicate |

A candidate is scored only against samples that share one of those indexed tokens. **Raising the
threshold makes the tool stricter about what counts as a duplicate; it does not make the tool look
at more pairs.** Two differently-worded questions whose overlap is entirely in common words are
never scored at all, at any threshold. Tune `tokensIndexedPerSample` upward for recall, not the
threshold downward — `lib.test.ts` demonstrates exactly that: the same pair, the same threshold,
found at width 4 and missed at width 1.

The scorer is `@crewhaus/dataset-ops`'s own `tokenOverlap` over its `normalizedTokens`, which is
exactly what the `near-duplicate-input` lint rule measures, and the index is built on that same
tokenizer. Both halves matter. A *different* tokenizer at the same threshold makes the two tools
disagree about what a duplicate IS — `well-known` vs `well known` scores 1.00 under the lint rule
and 0.62 under a tokenizer that keeps hyphens, so `DatasetMine` would propose a candidate as new
and `DatasetLint` would flag the row it just became. And an index built on a tokenizer the scorer
does not use cannot bound what the scorer would have found.

## "Could not determine" is not "no"

Every one of these is a named status in the result rather than an empty list:

| Situation | What comes back |
|---|---|
| The registry root does not exist | `registryExists: false` with a note — an absent registry, not an empty one |
| A version record is on disk but is not JSON | `status: "unreadable"` with the parse error; the version still lists |
| A record has samples but no stored hashes | `hashes.status: "unavailable"` — no digest is reported, because an empty digest would let two different datasets compare equal |
| Stored hashes no longer match the samples | `hashes.status: "mismatched"`, with the split, index and both hashes |
| The near-duplicate scan was too expensive | `nearDuplicateScan.performed: false` with the comparison count and cap |
| No graders / no spec / no other versions / nothing to scan | the rule is listed in `rulesNotEvaluated` with the reason |
| No session carried a trace sidecar | `signals["eval-fail"].available: false`, naming `CREWHAUS_WATCHME=1` — not "no turn failed its judge" |
| No audit log, or one no file in it could be opened | `signals["egress-block"].available: false` with the reason — not "no egress was blocked" |
| Some audit files opened and some did not | `available: true` with `partial: true` and `filesSkipped` |
| The dedupe target has no readable version | `dedupe.performed: false` — the candidates are UNCHECKED, not new |
| A listing or a candidate set hit its cap | `truncated: true`, so the list is read as a prefix |
| The dedupe corpus hit its index cap | `corpusTruncated: true` — a "new" verdict is a verdict about the indexed prefix |

A `DatasetPut` from a file that exceeds the sample cap is the one case where a cap **refuses**
instead of reporting: a version written from a partial read is a version that silently lost rows.

## Safety

- Every caller path — and `CREWHAUS_DATASETS_DIR` — goes through `resolveSafe` (copied verbatim
  from `@crewhaus/tool-pkg`), which refuses anything resolving outside `process.cwd()`, including
  via a symlink that lives inside the workspace. Every result says which root it used and where
  that root came from (`input` / `env` / `default`).
- A dataset file path is **never** handed to `loadDataset`, which dispatches `http(s)://` to a
  fetching loader. The extension of the *resolved, contained* path selects a local loader, so a
  caller-supplied URL can only ever be a (missing) local file.
- The PII/secret audit reports counts, kinds, fields and sample ids and **never** the matched text.
- The B18 canary phrase is never echoed. A tool result is prompt-side text, and a canary that
  reaches the prompt is precisely the contamination it was planted to detect — the sample id comes
  back instead, and the phrase stays derivable offline from `(name, version)`.
- Per-sample detail for the locked `test` split is withheld unless `allowTestSplit` is passed.
  Counts, hashes and PII *totals* are reported either way: a leak in the holdout is still a leak.
- Sample ids and rule messages are rendered before they are echoed. Ids come from a caller's file,
  and one carrying an ANSI escape or a newline would otherwise forge a line in whatever reads the
  result.
- No schema in this package can overwrite or delete a version. `allowOverwrite` is not reachable.

## What these tools do not do

- **They do not synthesize samples.** `crewhaus dataset synthesize`'s paraphrase path is
  model-backed; only the deterministic half would belong here, and half a feature is worse than a
  pointer to the CLI.
- **`DatasetMine` writes nothing.** Candidates come back for review and `DatasetPut` is the only
  writer, so there is one write path to reason about. Hand `candidates[].sample` straight to
  `DatasetPut`.
- **An egress block does not become a sample.** The audit record carries no turn input, and a
  sample whose input is an error string teaches nothing. Blocks are reported under
  `signals["egress-block"].blocks` so they can be joined by hand.
- **They never run an eval.** A clean lint says the dataset is well-formed, not that the harness
  will pass it.

## Known edges

- Sessions are listed by **name**, not mtime. The CLI orders by recency, which is friendlier
  interactively and is not reproducible across machines or after a copy; session ids are
  time-ordered in practice, so `maxSessions` takes the last N by name.
- `registryDir` is compared lexically before symlinks are resolved (that is `resolveSafe`'s first
  gate). On a host where the workspace path itself runs through a symlink — macOS `/var` →
  `/private/var`, for example — an **absolute** registry root spelled with the unresolved prefix is
  refused. Pass a relative root.
- `DatasetPut`'s dry run predicts the version, the splits and the content hash by deriving the
  per-sample hashes the way the registry derives them. `index.test.ts` asserts the prediction
  equals what the real put stored, rather than trusting that the two stay in step.
