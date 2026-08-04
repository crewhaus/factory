/**
 * Memory — the M3 half of the Memory tab: the facts browser with provenance,
 * the recall playground, the continuity panel and its trash, the wiki
 * browser/editor with versions and the link graph, watchme analytics and the
 * synthesize review, the learning panel, and knowledge sync.
 *
 * The M1 reads (`views/memory.js`: facts/wiki/state/dream/watchme cards)
 * stay where they are and are rendered above this.
 *
 * The invariant this screen exists to make VISIBLE: nothing here deletes.
 * Forgetting a fact writes a supersede tombstone with the operator's reason,
 * clearing continuity moves it to a restorable trash snapshot, and a wiki
 * article is archived rather than removed. Every one of those is reversible,
 * and the UI should say so at the point of the click.
 */

import { renderPendingSurface } from "../pending.js";

export async function renderMemoryFabric(root, _ctx) {
  renderPendingSurface(root, {
    group: "memory",
    title: "Memory fabric",
    blurb:
      "Facts with TTL, supersede chains and session provenance; the recall playground; continuity's proof ladder and trash; the wiki editor with expectedVersion, versions and links; watchme analytics, intents and synthesize review; learning and knowledge sync.",
  });
}
