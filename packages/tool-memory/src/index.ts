/**
 * Catalog R3 — tool-memory. Exposes `Remember`, `Recall`, and
 * `MemoryForget` tools that wrap @crewhaus/memory-store for
 * cross-session persistent memory (M4.2 of the heavy-hitter plan;
 * MemoryForget from the 0.3.0 memory release, design §3.4).
 *
 * Each tool is bound to a specific spec name at construction time so
 * one process can run multiple specs without their memories cross-
 * contaminating. The spec name is what `runChatLoop` passes as
 * `sessionName`; tool-catalog can supply it via factory functions
 * (`createMemoryTools(specName)`) or downstream consumers can wire
 * it through their own catalog initialization.
 *
 * Pillar 3: memory writes carry `origin: "user"` semantics (the user
 * is the one who decided what to remember). The runtime's session-
 * start hook reads recalled memories with the same origin so cached
 * verdicts apply correctly. No cross-origin lateral movement: a
 * memory written by one user cannot influence another user's session.
 * `MemoryForget` is destructive AND justification-gated (Pillar 3
 * intent gate): erasing memory is exactly the kind of side effect an
 * injected instruction would reach for, so every call must carry a
 * justification checked against the spec's instructions.
 *
 * Where `Recall` goes: with no embedder it reads the local file and ranks
 * with BM25, so it is `scope: "internal"`. When memory-service built the
 * store with an embedder that leaves the process (`memory.wiki.embedder`
 * naming anything but `mock/…`), each recall POSTs the query and the text of
 * the stored memories to that provider, so `Recall` is built
 * `scope: "external"` with `ioCapability: "network"`: the query goes through
 * the egress classifier and `compile --strict` counts it. It stays
 * `readOnly` (plan mode keeps it), and its destination is the operator's
 * configured embedder, never one the model picks. `Remember` and
 * `MemoryForget` never call the embedder.
 *
 * Deliberately NOT surfaced to the model: provenance. Model-supplied
 * evidence toolUseIds would be unverified claims — provenance stamping
 * belongs to the auto-capture path (`captureFacts`), which reads the
 * ids from the session event log itself.
 */
import { type MemoryStore, createMemoryStore } from "@crewhaus/memory-store";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export type CreateMemoryToolsOptions = {
  readonly specName: string;
  readonly rootDir?: string;
  /** Inject a custom store implementation for tests. */
  readonly store?: MemoryStore;
};

export type MemoryToolBundle = {
  readonly remember: RegisteredTool;
  readonly recall: RegisteredTool;
  /** Explicit forgetting (design §3.4) — destructive + justification-gated. */
  readonly forget: RegisteredTool;
  /** Exposed for direct inspection (tests, /clear-style ops). */
  readonly store: MemoryStore;
};

const MS_PER_DAY = 86_400_000;

const rememberSchema = z.object({
  text: z.string().min(1).describe("The fact to remember. One short, self-contained sentence."),
  tags: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe("Optional tags for grouping (e.g. 'family', 'work', 'preference')."),
  ttlDays: z
    .number()
    .positive()
    .max(3650)
    .optional()
    .describe(
      "Optional time-to-live in days. After it elapses the memory expires and stops being recalled. Omit to keep the memory indefinitely.",
    ),
});

const recallSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Text to search for. Returns the top-K matching memories ranked by relevance."),
  k: z.number().int().min(1).max(50).optional().describe("Max results to return. Default 5."),
});

const forgetSchema = z.object({
  id: z
    .string()
    .regex(/^mem_[0-9a-f]{16}$/)
    .optional()
    .describe("Exact memory id (mem_…) to forget. Provide id OR query, not both."),
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Text query — forgets EVERY live memory matching it (the same match set Recall returns). Provide id OR query, not both.",
    ),
  reason: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Why this memory is wrong/stale. Recorded on the tombstone for audit."),
});

/**
 * Construct the Remember + Recall + MemoryForget tools bound to a spec's
 * memory store. The caller is expected to add the returned tools to the
 * runtime's tool catalog (e.g. `defaultCatalog.register(bundle.remember)`).
 */
export function createMemoryTools(opts: CreateMemoryToolsOptions): MemoryToolBundle {
  const store: MemoryStore =
    opts.store ??
    createMemoryStore({
      specName: opts.specName,
      ...(opts.rootDir !== undefined ? { rootDir: opts.rootDir } : {}),
    });

  const remember: RegisteredTool = buildTool({
    name: "Remember",
    description:
      "Store a fact for future sessions. Use sparingly — once a user mentions something they want you to remember (preferences, important dates, contact details, opinions), call this. The memory persists in `.crewhaus/memories/<spec>.jsonl` and is searchable via Recall. An optional ttlDays makes the memory expire.",
    inputSchema: rememberSchema,
    destructive: true, // writes to disk — gate behind permissions
    execute: async (input) => {
      const entry = await store.remember(
        input.text,
        input.tags ?? [],
        input.ttlDays !== undefined ? { ttlMs: input.ttlDays * MS_PER_DAY } : {},
      );
      const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      const ttlSuffix =
        entry.expiresAt !== undefined
          ? ` (expires ${new Date(entry.expiresAt).toISOString()})`
          : "";
      return `remembered (${entry.id})${tagSuffix}${ttlSuffix}: ${entry.text}`;
    },
  });

  // An embedder that leaves the process receives the query and every live
  // memory's text on recall, so the tool says so (see the module doc).
  const networked = store.embedderLeavesProcess === true;
  const recall: RegisteredTool = buildTool({
    name: "Recall",
    description: networked
      ? "Search prior memories for relevance to a query. Use at the start of a session, or whenever the user references something you might have stored. Returns up to K results ranked by BM25 plus embedding similarity, ordered most-relevant first. The query and the stored memories are sent to the configured embedding provider."
      : "Search prior memories for relevance to a query. Use at the start of a session, or whenever the user references something you might have stored. Returns up to K results ranked by BM25 relevance score, ordered most-relevant first.",
    inputSchema: recallSchema,
    readOnly: true,
    ...(networked ? { scope: "external" as const, ioCapability: "network" as const } : {}),
    execute: async (input) => {
      const k = input.k ?? 5;
      const results = await store.recall(input.query, k);
      if (results.length === 0) {
        return `no memories matched "${input.query}" (store size: ${await store.size()})`;
      }
      const lines = [`${results.length} memory match(es) for "${input.query}":`];
      for (const r of results) {
        const tagSuffix = r.entry.tags.length > 0 ? ` [${r.entry.tags.join(", ")}]` : "";
        lines.push(`  • (${r.score.toFixed(2)}) ${r.entry.text}${tagSuffix}`);
      }
      return lines.join("\n");
    },
  });

  const forget: RegisteredTool = buildTool({
    name: "MemoryForget",
    description:
      "Explicitly forget stored memories that are wrong, stale, or superseded. Provide either an exact id (mem_…, from Recall/Remember output) or a query — a query forgets EVERY matching memory, so prefer ids when possible. Forgotten memories stop being recalled but remain in the file as superseded (audit trail; never a hard delete).",
    inputSchema: forgetSchema,
    destructive: true,
    // Pillar 3 intent gate: erasing memory is a high-leverage side effect —
    // every call must justify itself against the spec's instructions.
    requireJustification: true,
    execute: async (input) => {
      const hasId = input.id !== undefined;
      const hasQuery = input.query !== undefined;
      if (hasId === hasQuery) {
        return "MemoryForget: provide exactly one of `id` or `query`.";
      }
      const target = (hasId ? input.id : input.query) as string;
      const forgotten = await store.forget(
        target,
        input.reason !== undefined ? { reason: input.reason } : {},
      );
      if (forgotten.length === 0) {
        return `nothing to forget — no live memory matched ${hasId ? `id ${target}` : `"${target}"`}`;
      }
      const lines = [
        `forgot ${forgotten.length} memory(ies)${input.reason !== undefined ? ` — ${input.reason}` : ""}:`,
      ];
      for (const e of forgotten) {
        lines.push(`  • (${e.id}) ${e.text}`);
      }
      return lines.join("\n");
    },
  });

  return { remember, recall, forget, store };
}
