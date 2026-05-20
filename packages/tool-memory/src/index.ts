/**
 * Catalog R3 — tool-memory. Exposes `Remember` and `Recall` tools that
 * wrap @crewhaus/memory-store for cross-session persistent memory
 * (M4.2 of the heavy-hitter plan).
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
  /** Exposed for direct inspection (tests, /clear-style ops). */
  readonly store: MemoryStore;
};

const rememberSchema = z.object({
  text: z.string().min(1).describe("The fact to remember. One short, self-contained sentence."),
  tags: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe("Optional tags for grouping (e.g. 'family', 'work', 'preference')."),
});

const recallSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Text to search for. Returns the top-K matching memories ranked by relevance."),
  k: z.number().int().min(1).max(50).optional().describe("Max results to return. Default 5."),
});

/**
 * Construct the Remember + Recall tool pair bound to a spec's memory
 * store. The caller is expected to add the returned tools to the
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
      "Store a fact for future sessions. Use sparingly — once a user mentions something they want you to remember (preferences, important dates, contact details, opinions), call this. The memory persists in `.crewhaus/memories/<spec>.jsonl` and is searchable via Recall.",
    inputSchema: rememberSchema,
    destructive: true, // writes to disk — gate behind permissions
    execute: async (input) => {
      const entry = await store.remember(input.text, input.tags ?? []);
      const tagSuffix = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      return `remembered (${entry.id})${tagSuffix}: ${entry.text}`;
    },
  });

  const recall: RegisteredTool = buildTool({
    name: "Recall",
    description:
      "Search prior memories for relevance to a query. Use at the start of a session, or whenever the user references something you might have stored. Returns up to K results ranked by BM25 relevance score, ordered most-relevant first.",
    inputSchema: recallSchema,
    readOnly: true,
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

  return { remember, recall, store };
}
