/**
 * Knowledge: what this harness remembers and the workspace it shares. Rows
 * as in `overview.js`. `hidden` keeps a row out of the sub-view list (a wiki
 * article is reached from its list, never browsed to), and a row whose
 * `capture` is `required` resolves only with it.
 */

import { stack } from "./stack.js";

export const KNOWLEDGE = Object.freeze({
  id: "knowledge",
  label: "Knowledge",
  describe: "What it remembers, and the workspace it shares.",
  index: null,
  // biome-ignore format: one row per line, so an area appends its row without touching the shell
  views: Object.freeze([
    { id: "memory", label: "Memory", describe: "Facts, notes, the wiki and what it has learned.", load: () => Promise.all([import("../views/memory.js"), import("../views/memory-fabric.js")]), render: async ([memory, fabric], root, ctx) => { await memory.renderMemory(root, ctx); await fabric.renderMemoryFabric(stack(root), ctx); }, rest: true, gate: { shapes: ["cli", "workflow", "channel", "managed", "crew", "research", "batch", "voice", "browser"], why: "this target's schema admits neither a memory: nor a continuity: block, so there is no fabric to read" } },
    { id: "thredz", label: "Thredz", describe: "Its shared Thredz workspace: wiki, records, goals and tasks.", load: () => import("../views/thredz.js"), render: (m, root, ctx) => m.renderThredz(root, ctx), rest: true, gate: { shapes: ["cli", "channel", "managed", "crew", "research"], why: "this target's schema admits no thredz: block, so there is no workspace for the manager to proxy" } },
    { id: "wiki", label: "Wiki article", describe: "One article from its wiki.", load: () => import("../views/memory.js"), render: (m, root, ctx) => m.renderMemory(root, ctx), capture: ["wikiSlug"], required: true, deep: true, hidden: true },
  ]),
});
