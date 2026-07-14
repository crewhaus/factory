---
name: dream
description: Consolidation playbook for scheduled dream runs — merge and reconcile knowledge, move confidence with evidence, promote corroborated facts, refresh next actions. Consumed by dream ticks, not user-invoked.
---
You are running a consolidation pass — the dream. This is scheduled
maintenance of the knowledge base, not a conversation: there is no user to
ask, and the pass is judged by the state it leaves behind, not by prose.

You are seeded with the deterministic phase-1 findings: session summaries,
fact dedupe and supersede results, staleness flags, promotion candidates
(facts recalled repeatedly or corroborated across sessions), and the open
plans. Work from those findings — do not re-derive them.

## The playbook

Work in this order; skip any step whose finding list is empty.

1. **Merge and split articles.** Where findings flag overlapping or
   conflated articles: merge duplicates into the canonical slug; split an
   article that conflates two concepts. Use `wiki_write` upserts — article
   versions make every merge reversible. One article per concept.
2. **Reconcile contradictions.** For each flagged contradiction, open both
   sides with `wiki_get` and their neighbours with `wiki_related`, and
   decide from evidence. Correct or supersede the losing article —
   supersede, never delete.
3. **Move confidence with evidence, in both directions.** Via
   `wiki_set_signals`: demote articles contradicted by newer sessions or
   unverified past their staleness window; promote articles corroborated
   by independent evidence. Every signal change must have a reason you
   could cite — a session, a source, a contradiction. No re-scoring on
   vibes.
4. **Promote corroborated facts.** Turn flagged promotion candidates into
   cited wiki drafts with `wiki_write` — the evidence trail becomes the
   `## Sources` section, and the confidence score stays honest. No source,
   no promotion.
5. **Retire what was superseded.** Where findings mark facts stale or
   duplicated, retire them explicitly with `MemoryForget` — a supersede
   tombstone, never a hard delete.
6. **Log what you could not fix.** A contradiction you cannot resolve, a
   stale article with no primary source in reach — log each with
   `log_knowledge_gap` so the next study pass inherits it.
7. **Refresh next actions.** Rebuild the plan's next actions from what
   consolidation revealed via `PlanUpdate`, so the next interactive
   session starts pointed at the right work.

## Rules

- **Every mutation goes through the normal tools** — `wiki_write`,
  `wiki_set_signals`, `MemoryForget`, `PlanUpdate`. No side channels: each
  action leaves its own tool-result proof and passes the usual
  justification and audit checks.
- **Respect the budget.** The pass is budget-capped. Take the
  highest-value consolidations first — contradictions, then merges, then
  promotions — and when the budget nears, stop cleanly and log the
  remainder as gaps rather than rushing low-quality writes.
- **Reversibility is the invariant.** Versioned upserts, supersede
  tombstones, trash instead of deletion. If an action cannot be undone, do
  not take it.
