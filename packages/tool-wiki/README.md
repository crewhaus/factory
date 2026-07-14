# @crewhaus/tool-wiki

v0.3.0 Goal 2 (design §3.2): the **thredz-identical wiki tool vocabulary**
over [`@crewhaus/wiki-store`](../wiki-store) — exactly thredz-mcp's tool
names and input schemas, so one skill vocabulary and one set of permission
rules work on both the local and Thredz backends (a parity test pins the
name set).

```ts
import { createWikiTools } from "@crewhaus/tool-wiki";
import { defaultCatalog } from "@crewhaus/tool-catalog";

const bundle = createWikiTools({
  specName: "support-bot",
  requireSources: true,                    // learning-mode write governance
  appendEvent: (e) => eventLog.append(e),  // wiki_write event kind
  logGap: (gap) => planStore.logGap(gap),  // wired by the composition root
});
for (const tool of bundle.all) defaultCatalog.register(tool);
```

## The tool table

| Tool | Flags | What it does |
| --- | --- | --- |
| `wiki_recall` | readOnly | PRIMARY RECALL: hybrid top-k WITH bodies + one-hop link expansion |
| `wiki_semantic_search` | readOnly | Embedding-only ranking; degrades to keyword search (with a note) when no embedder is configured |
| `wiki_search` | readOnly | BM25 keyword search — exact terms, names, numbers |
| `wiki_get` | readOnly | One article in full (or `concise`) |
| `wiki_write` | destructive + **requireJustification** | Versioned upsert by slug — supersede, never delete |
| `wiki_list` | readOnly | REFLECT entry point — stalest first by default (thredz sort=updated asc) |
| `wiki_related` | readOnly | Tag/link/similarity neighbors for dedup + contradiction checks |
| `wiki_set_signals` | destructive + **requireJustification** | verified / confidenceScore promotion+demotion |
| `wiki_stats` | readOnly | Corpus health |
| `log_knowledge_gap` | destructive (sideEffect audit-and-allow, **no** justification) | Record what the expert could not answer |

All tools are `scope: "internal"` — local files, no network.

## Pillar 3 — the `memory` TrustOrigin

Article bodies returned by the read tools are classified via
`boundary-classifier` at the new **`"memory"` origin** (default policy:
block tier, like `"skill"`) before reaching the model — an article written
in an earlier session may have absorbed attacker text, and recall re-injects
it across a session boundary. Malicious verdicts return the redaction notice
instead of the body; non-blocked bodies are `tagContent`-ed into
`RunContext.dataLineage` under `"memory"` (the skills-registry two-site
pattern) so the egress fabric can attribute a later exfiltration to the
memory boundary.

## Write-path governance

With `{ requireSources: true }` (implied by `learning.enabled`, PR 17),
`wiki_write` deterministically rejects any body without a `## Sources`
heading — no citation, no write. Sources listed under that heading are also
extracted into the article's frontmatter `sources[]`.

## Concurrency + parity notes

`wiki_write` performs the same client-side upsert as thredz-mcp: it reads
the current version and passes it as the store's `expectedVersion`; a
concurrent editor surfaces as the thredz-parity `stale_article_version`
remediation ("re-read it with wiki_get, then re-apply your edit").
`visibility` and `category` are accepted for schema parity — the local wiki
is private by construction, and categories are a Thredz-side concept.

Without an injected `logGap`, `log_knowledge_gap` writes a draft
`gap-<topic>` article under the reserved `gaps/` tag (plus
`priority:<p>`), so the STUDY loop can find gaps with
`wiki_list tags=gaps/` even standalone.
