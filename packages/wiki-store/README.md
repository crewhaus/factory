# @crewhaus/wiki-store

v0.3.0 Goal 2 (design §3.1): the local, update-in-place **semantic memory
tier** — what the append-only fact store deliberately cannot be. Markdown
articles with YAML frontmatter under `.crewhaus/wiki/<spec>/`, versioned
forever, retrieved with hybrid ranking + link-graph expansion.

```
.crewhaus/wiki/<spec>/
  articles/<slug>.md        # live version: YAML frontmatter + markdown body
  versions/<slug>/<n>.md    # immutable priors — supersede, never delete
  index.json                # slug → {title, tags, confidence, verified,
                            #         version, updatedAt, links[], status}
  .lock                     # advisory single-writer lock (§7.6)
```

```ts
import { createWikiStore } from "@crewhaus/wiki-store";
import { createEmbedder } from "@crewhaus/embedder";

const wiki = createWikiStore({
  specName: "support-bot",
  embedder: createEmbedder({ model: "mock/deterministic" }), // optional
});

await wiki.write({ slug: "csv-delimiters", title: "CSV delimiter conventions",
  body: "…see [[eu-locale-rules]]\n\n## Sources\n- RFC 4180" });
const hits = await wiki.recall("csv delimiter", 6);   // hybrid + one-hop
```

## The interface (design §3.1, verbatim)

`recall` / `search` / `get` / `write` / `list` / `related` / `setSignals` /
`stats` — plus one extension: `semanticSearch?` exists when an `embedder`
was supplied (the thredz-parity `wiki_semantic_search` tool needs a pure
cosine ranking with a `minScore` floor, which the fused recall score cannot
express).

## Optimistic concurrency — the Thredz PATCH contract

`write()` upserts by slug. Updating an existing article REQUIRES
`expectedVersion` equal to its current version; a mismatch throws
`WikiVersionConflictError` whose `conflictCode` (and message) carry the
literal `stale_article_version` — the same contract as Thredz's HTTP 409,
so skills behave identically on both backends: re-read with `get`, then
re-apply the edit. Every content edit copies the outgoing file into
`versions/<slug>/<n>.md` FIRST (supersede, never delete — Theanine), then
lands atomically (tmp+rename).

## Retrieval

- **Hybrid BM25 + embeddings via RRF (k=60)** — the same recipe as
  memory-store's PR-6 hybrid recall. No embedder ⇒ BM25-only (offline
  default, regression-pinned).
- **Contextual chunk headers** — every article is indexed as
  `title\n[tags: …]\n\nbody`.
- **One-hop link expansion** with a documented re-rank rule: primary
  candidates keep their reciprocal-rank vote `1/(60+rank)`; every one-hop
  `[[wikilink]]` neighbor (either edge direction) of a top-k seed gains a
  **half-weight** link vote `0.5/(60+bestSeedRank)`; votes sum, ties break
  by slug. Half weight means a link corroborates but never displaces a
  genuine match — while a linked-but-lexically-unrelated article still
  surfaces when the query has fewer than k solid matches.

## Semantics worth knowing

- `list({ staleFirst: true })` sorts `updatedAt` ascending — the REFLECT
  pass order (matches thredz `wiki_list` sort=updated order=asc).
- `related(slug)` = shared tags (1 each) + link edges (2 each direction) +
  cosine similarity when an embedder is present.
- `setSignals` (verified/confidence) is metadata-only: **no version bump,
  no snapshot**. A content `write()` RESETS `verified` to false — a new
  version is a new, not-yet-fact-checked claim.
- `index.json` is a derived cache: reads fall back to a scan of
  `articles/` when it is missing or corrupt, and every mutation rewrites
  it from that authoritative scan (crash-safe by construction).

## Concurrency + tenancy

Mutations run under the §7.6 advisory `.lock`: wait up to 2 s → steal a
lock whose mtime is >30 s stale (with a `lock_stolen` warning) → fail
naming the holder pid. Reads never take the lock; atomic writes mean a
reader never observes a torn file. Under a tenant context (ambient
`withTenant` or the explicit `tenant` option) every resolved path is
fenced fail-closed against the tenant's root (CWE-1230), and the default
root becomes `<tenantRoot>/wiki`.
