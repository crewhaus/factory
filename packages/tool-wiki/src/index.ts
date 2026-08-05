/**
 * v0.3.0 Goal 2 — `tool-wiki` (design §3.2, PR 9).
 *
 * RegisteredTools over `@crewhaus/wiki-store` carrying EXACTLY the
 * thredz-mcp wiki tool vocabulary — names and input schemas — so one skill
 * vocabulary, one set of permission rules, and one `tool_config` surface
 * work identically on the local and Thredz backends (when `backend:
 * thredz`, these local tools are not registered and the synthesized Thredz
 * MCP server's tools alias onto the same names):
 *
 *   wiki_recall           readOnly    — PRIMARY RECALL, hybrid + one-hop
 *   wiki_semantic_search  readOnly    — embedding-only ranking; degrades
 *                                       to keyword search with a note when
 *                                       no embedder is configured (the same
 *                                       degradation Thredz applies on
 *                                       keyword-only plans)
 *   wiki_search           readOnly    — BM25 keyword search
 *   wiki_get              readOnly    — one article in full
 *   wiki_write            destructive + requireJustification — versioned
 *                                       upsert (supersede, never delete)
 *   wiki_list             readOnly    — REFLECT entry point (stale-first
 *                                       by default: sort updated asc)
 *   wiki_related          readOnly    — dedup/contradiction candidates
 *   wiki_set_signals      destructive + requireJustification — verified /
 *                                       confidence promotion+demotion
 *   wiki_stats            readOnly    — corpus health
 *   log_knowledge_gap     destructive (sideEffect audit-and-allow — NO
 *                                       justification; logging a gap is the
 *                                       honest low-friction path, §7.4)
 *
 * All tools are `scope: "internal"` — local files, no network.
 *
 * ## Pillar 3 — the `memory` TrustOrigin (two-site pattern)
 *
 * Article bodies returned by the read tools (`wiki_recall`, `wiki_get`)
 * are classified at the new `"memory"` TrustOrigin BEFORE they reach the
 * model: a wiki article written in an earlier session may have absorbed
 * attacker text (a poisoned page STUDYed into an article), and recall
 * re-injects it across a session boundary. On a malicious verdict the body
 * is replaced by the redaction notice; on a non-blocked verdict the body
 * is `tagContent`-ed into `RunContext.dataLineage` under origin `"memory"`
 * (the skills-registry two-site pattern) so the sink-side egress fabric
 * can attribute a later exfiltration to the memory boundary.
 *
 * ## Write-path governance (design §3.3)
 *
 * Constructed with `{ requireSources: true }` (the learning-mode
 * enforcement), `wiki_write` deterministically REJECTS bodies without a
 * `## Sources` heading — what was prompt-only discipline in the expert
 * demo becomes a hard gate. Default false.
 *
 * ## `log_knowledge_gap` (decoupled)
 *
 * Takes an injected `logGap` callback — the plan-store wiring happens in
 * the composition-root PR; this package never imports continuity-store.
 * Without a callback the tool still works standalone: the gap is written
 * into the wiki itself as a `gap-<topic>` article under the reserved
 * `gaps/` tag, so the STUDY loop can find it with `wiki_list`.
 *
 * Mutations emit the additive event-log kind `wiki_write` through an
 * injected `appendEvent` seam (tool-plan's pattern) — emitters or
 * memory-service decide where events land; nothing here imports runtime
 * wiring.
 */
import { buildRedactionNotice, classifyBoundary } from "@crewhaus/boundary-classifier";
import type { WikiWriteEventPayload } from "@crewhaus/event-log";
import { type RunContext, formatAgentIdentity, tagContent } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import {
  type WikiCreatedBy,
  type WikiEmbedder,
  type WikiHit,
  type WikiRef,
  type WikiStore,
  WikiVersionConflictError,
  createWikiStore,
} from "@crewhaus/wiki-store";
import { z } from "zod";

/**
 * The thredz-mcp wiki tool names, pinned (server.ts TOOLS, v0.2.0). The
 * parity test asserts the registered set equals this list EXACTLY — a
 * drifted name would silently fork the skill vocabulary between backends.
 */
export const THREDZ_WIKI_TOOL_NAMES = [
  "wiki_recall",
  "wiki_semantic_search",
  "wiki_search",
  "wiki_get",
  "wiki_write",
  "wiki_list",
  "wiki_related",
  "wiki_set_signals",
  "wiki_stats",
  "log_knowledge_gap",
] as const;

/** The reserved tag marking standalone-logged knowledge gaps (§3.2). */
export const GAPS_TAG = "gaps/";

/** A recorded knowledge gap — the `logGap` callback's input. */
export type KnowledgeGap = {
  readonly topic: string;
  readonly detail?: string;
  readonly tags: readonly string[];
  readonly priority: "low" | "medium" | "high";
};

/** The `wiki_write` event emitted through the injected append seam. */
export type WikiEvent = { readonly kind: "wiki_write"; readonly payload: WikiWriteEventPayload };

/**
 * The injected append seam: typically wired to the session event log's
 * `append` (and/or the trace bus) by the emitter or memory-service. Should
 * not throw; a throwing sink fails the tool call loudly rather than
 * dropping audit events silently.
 */
export type AppendWikiEvent = (event: WikiEvent) => void | Promise<void>;

export type CreateWikiToolsOptions = {
  readonly specName: string;
  readonly rootDir?: string;
  /** Inject a custom store implementation for tests. */
  readonly store?: WikiStore;
  /** Enables hybrid recall + real `wiki_semantic_search` on the default store. */
  readonly embedder?: WikiEmbedder;
  /**
   * Learning-mode write governance (design §3.3): when true, `wiki_write`
   * deterministically rejects bodies without a `## Sources` heading.
   */
  readonly requireSources?: boolean;
  /** Gap sink — the composition root wires this to the plan store. Absent →
   *  the standalone wiki fallback under the `gaps/` tag. */
  readonly logGap?: (gap: KnowledgeGap) => string | Promise<string>;
  /** Event-log append seam — see `AppendWikiEvent`. */
  readonly appendEvent?: AppendWikiEvent;
  readonly now?: () => Date;
};

export type WikiToolBundle = {
  readonly recall: RegisteredTool;
  readonly semanticSearch: RegisteredTool;
  readonly search: RegisteredTool;
  readonly get: RegisteredTool;
  readonly write: RegisteredTool;
  readonly list: RegisteredTool;
  readonly related: RegisteredTool;
  readonly setSignals: RegisteredTool;
  readonly stats: RegisteredTool;
  readonly logKnowledgeGap: RegisteredTool;
  /** Every tool above, registration-ready. */
  readonly all: readonly RegisteredTool[];
  /** Exposed for direct inspection (tests, CLI verbs). */
  readonly store: WikiStore;
};

// ---------------------------------------------------------------------------
// schemas — field-for-field mirrors of thredz-mcp's TOOLS inputSchemas
// ---------------------------------------------------------------------------

/**
 * `space` rides on every wiki tool for cross-backend parity with thredz-mcp
 * 0.3.0, which accepts it on all nine. Locally it is a no-op — the file wiki is
 * a single unspaced corpus — but accepting it means a spec written against the
 * Thredz backend still runs unchanged over files, which is the whole point of
 * the parity contract (`backend-conformance`, and the schema-mirror test).
 */
const spaceField = z
  .string()
  .optional()
  .describe(
    "Thredz wiki space slug or id (accepted for cross-backend parity, meaningless locally — the local wiki is a single unspaced corpus)",
  );

const recallSchema = z.object({
  query: z.string().min(1).describe("what to recall about"),
  limit: z.number().int().min(1).max(50).optional().describe("max snippets (default 6)"),
  space: spaceField,
});

const semanticSearchSchema = z.object({
  query: z.string().min(1).describe("natural-language query"),
  limit: z.number().int().min(1).max(50).optional().describe("max results (default 6)"),
  minScore: z.number().min(0).max(1).optional().describe("similarity floor 0–1 (default 0.05)"),
  space: spaceField,
});

const searchSchema = z.object({
  query: z.string().min(1).describe("keyword query"),
  space: spaceField,
});

const getSchema = z.object({
  slug: z.string().min(1).describe("article slug"),
  concise: z.boolean().optional().describe("trim to essentials"),
  space: spaceField,
});

const articleStatusSchema = z.enum(["draft", "published", "review", "archived"]);

const writeSchema = z.object({
  slug: z.string().min(1).describe("stable kebab-case identifier"),
  title: z.string().min(1).describe("article title"),
  body: z.string().min(1).describe("Markdown body — include a ## Sources section with citations"),
  summary: z.string().optional().describe("one-line summary"),
  tags: z.array(z.string().min(1)).optional().describe("lowercase topic tags"),
  category: z.string().optional().describe("category slug (optional)"),
  status: articleStatusSchema
    .optional()
    .describe("draft | published | review | archived (default published)"),
  confidenceScore: z.number().min(0).max(1).optional().describe("0–1 confidence in this knowledge"),
  editMessage: z.string().optional().describe("what changed and why"),
  visibility: z
    .enum(["private", "shared"])
    .optional()
    .describe(
      "'private' (default — the local wiki is private by construction) | 'shared' (a Thredz concept; accepted for cross-backend parity, meaningless locally)",
    ),
  space: spaceField,
});

const listSchema = z.object({
  query: z.string().optional().describe("optional relevance filter"),
  tags: z.string().optional().describe("comma-separated tags"),
  category: z.string().optional().describe("category slug"),
  status: z.string().optional().describe("draft | published | review | archived | all"),
  sort: z
    .string()
    .optional()
    .describe("updated | created | title | relevance | popular | trending"),
  order: z.string().optional().describe("asc | desc"),
  limit: z.number().int().min(1).max(100).optional().describe("page size (default 25, max 100)"),
  space: spaceField,
});

const relatedSchema = z.object({
  slug: z.string().min(1).describe("article slug"),
  space: spaceField,
});

const setSignalsSchema = z.object({
  space: spaceField,
  slug: z.string().min(1).describe("article slug"),
  verified: z.boolean().optional().describe("fact-checked"),
  confidenceScore: z.number().min(0).max(1).optional().describe("0–1"),
});

const statsSchema = z.object({
  space: spaceField,
});

const logGapSchema = z.object({
  topic: z.string().min(1).describe("the topic the expert was weak on"),
  detail: z.string().optional().describe("what specifically was missing"),
  tags: z.array(z.string().min(1)).optional(),
  priority: z.enum(["low", "medium", "high"]).optional().describe("low | medium | high"),
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The learning-mode gate: a `## Sources` heading anywhere in the body. */
export function hasSourcesHeading(body: string): boolean {
  return /^##\s+Sources\b/m.test(body);
}

/** Bullet/plain lines under the `## Sources` heading (frontmatter sources[]). */
export function extractSources(body: string, cap = 20): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^##\s+Sources\b/.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break; // next heading ends the section
    const cleaned = line.replace(/^\s*[-*+]\s+/, "").trim();
    if (cleaned === "") continue;
    out.push(cleaned);
    if (out.length >= cap) break;
  }
  return out;
}

/** Kebab-case a free-text topic into a slug fragment. */
function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug === "" ? "unnamed" : slug;
}

/**
 * Resolve the run's `RunContext` for provenance tagging — the
 * skills-registry pattern: prefer `ctx.runContext` (threaded on every tool
 * execute), fall back to the opaque runtime bridge's `runContext`.
 */
function resolveRunContext(ctx: ToolExecuteContext | undefined): RunContext | undefined {
  if (ctx?.runContext !== undefined) return ctx.runContext;
  const bridge = ctx?.bridge as { runContext?: RunContext } | undefined;
  return bridge?.runContext;
}

/**
 * Pillar 3 source side, applied to ONE article body: classify at origin
 * `"memory"`, return the redaction notice on a malicious verdict, tag the
 * lineage otherwise. The caller splices the result into its rendering.
 */
async function classifyBody(body: string, rc: RunContext | undefined): Promise<string> {
  const boundary = await classifyBoundary(body, { origin: "memory" });
  if (boundary.action === "redact") {
    return boundary.redacted ?? buildRedactionNotice(boundary.verdict.hits);
  }
  if (rc !== undefined) {
    tagContent(rc, body, "memory");
  }
  return body;
}

function refLine(ref: WikiRef): string {
  const tagSuffix = ref.tags.length > 0 ? ` [${ref.tags.join(", ")}]` : "";
  const verifiedSuffix = ref.verified ? " ✓verified" : "";
  return `${ref.slug} (v${ref.version}, ${ref.status}, conf ${ref.confidence.toFixed(2)}${verifiedSuffix}) — ${ref.title}${tagSuffix}`;
}

function hitHeader(hit: WikiHit): string {
  const viaSuffix = hit.via === "link" ? ", via link" : "";
  return `--- ${refLine(hit.ref)} (score ${hit.score.toFixed(4)}${viaSuffix})`;
}

const STALE_WRITE_REMEDIATION =
  "the article changed under you (stale version) — re-read it with wiki_get, then re-apply your edit";

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

export function createWikiTools(opts: CreateWikiToolsOptions): WikiToolBundle {
  const now = opts.now ?? (() => new Date());
  const store: WikiStore =
    opts.store ??
    createWikiStore({
      specName: opts.specName,
      ...(opts.rootDir !== undefined ? { rootDir: opts.rootDir } : {}),
      ...(opts.embedder !== undefined ? { embedder: opts.embedder } : {}),
      now,
    });
  const requireSources = opts.requireSources === true;

  function createdByFrom(ctx: ToolExecuteContext | undefined): WikiCreatedBy | undefined {
    const rc = resolveRunContext(ctx);
    if (rc === undefined) return undefined;
    return {
      sessionId: rc.sessionId,
      ...(rc.agentIdentity !== undefined
        ? { agentIdentity: formatAgentIdentity(rc.agentIdentity) }
        : {}),
    };
  }

  async function emit(payload: WikiWriteEventPayload): Promise<void> {
    if (opts.appendEvent === undefined) return;
    await opts.appendEvent({ kind: "wiki_write", payload });
  }

  const recall: RegisteredTool = buildTool({
    name: "wiki_recall",
    description:
      "PRIMARY RECALL. Fetch the most relevant slice of the expert's own wiki for a query — a combined keyword + semantic-vector context bundle. Call this FIRST on every user question before answering.",
    inputSchema: recallSchema,
    readOnly: true,
    scope: "internal",
    execute: async (input, ctx) => {
      const rc = resolveRunContext(ctx);
      const hits = await store.recall(input.query, input.limit ?? 6);
      if (hits.length === 0) {
        return `no wiki articles matched "${input.query}" — if this is a real gap, record it with log_knowledge_gap`;
      }
      const lines = [`${hits.length} wiki hit(s) for "${input.query}":`];
      for (const hit of hits) {
        lines.push("", hitHeader(hit), await classifyBody(hit.body, rc));
      }
      return lines.join("\n");
    },
  });

  const semanticSearch: RegisteredTool = buildTool({
    name: "wiki_semantic_search",
    description:
      "Vector/semantic search over the wiki. Use when a query is conceptual and keyword search would miss paraphrases.",
    inputSchema: semanticSearchSchema,
    readOnly: true,
    scope: "internal",
    execute: async (input) => {
      const k = input.limit ?? 6;
      if (store.semanticSearch === undefined) {
        // Thredz-parity degradation: keyword-only plans fall back too.
        const refs = await store.search(input.query);
        const lines = [
          "no embedder configured — degraded to keyword search (configure memory.wiki.embedder for semantic ranking):",
        ];
        for (const ref of refs.slice(0, k)) lines.push(`  • ${refLine(ref)}`);
        if (refs.length === 0) lines.push(`  (no keyword matches for "${input.query}")`);
        return lines.join("\n");
      }
      const hits = await store.semanticSearch(input.query, k, input.minScore ?? 0.05);
      if (hits.length === 0) {
        return `no semantic matches ≥ ${(input.minScore ?? 0.05).toFixed(2)} for "${input.query}"`;
      }
      const lines = [`${hits.length} semantic match(es) for "${input.query}":`];
      for (const hit of hits) {
        lines.push(`  • (${hit.score.toFixed(3)}) ${refLine(hit.ref)}`);
      }
      return lines.join("\n");
    },
  });

  const search: RegisteredTool = buildTool({
    name: "wiki_search",
    description:
      "Keyword/full-text search over the wiki with scored snippets. Use for exact terms, names, numbers.",
    inputSchema: searchSchema,
    readOnly: true,
    scope: "internal",
    execute: async (input) => {
      const refs = await store.search(input.query);
      if (refs.length === 0) return `no wiki articles matched "${input.query}"`;
      const lines = [`${refs.length} keyword match(es) for "${input.query}":`];
      for (const ref of refs) lines.push(`  • ${refLine(ref)}`);
      return lines.join("\n");
    },
  });

  const CONCISE_CHARS = 600;

  const get: RegisteredTool = buildTool({
    name: "wiki_get",
    description:
      "Read one wiki article in full by its slug (e.g. after a search returns a promising hit).",
    inputSchema: getSchema,
    readOnly: true,
    scope: "internal",
    execute: async (input, ctx) => {
      const rc = resolveRunContext(ctx);
      const article = await store.get(input.slug);
      if (article === null) return `no wiki article with slug "${input.slug}"`;
      const safeBody = await classifyBody(article.body, rc);
      const body =
        input.concise === true && safeBody.length > CONCISE_CHARS
          ? `${safeBody.slice(0, CONCISE_CHARS).trimEnd()}\n… (concise — call wiki_get without concise for the full body)`
          : safeBody;
      const header = [
        `# ${article.title}`,
        `slug: ${article.slug} · v${article.version} · ${article.status} · confidence ${article.confidence.toFixed(2)}${article.verified ? " · ✓verified" : ""}`,
        article.tags.length > 0 ? `tags: ${article.tags.join(", ")}` : "",
        article.sources.length > 0 ? `sources: ${article.sources.join(" · ")}` : "",
        `updated: ${article.updatedAt}${article.supersedes !== undefined ? ` (supersedes v${article.supersedes})` : ""}`,
      ].filter((l) => l !== "");
      return `${header.join("\n")}\n\n${body}`;
    },
  });

  const write: RegisteredTool = buildTool({
    name: "wiki_write",
    description:
      "UPSERT a durable article into the wiki by slug (creates, or patches the existing one). This is how the expert commits time-tested, high-value knowledge to long-term memory. Include sources and a confidenceScore.",
    inputSchema: writeSchema,
    destructive: true,
    // Pillar 3 intent gate (§7.4): committing knowledge to long-term memory
    // is exactly what an injected instruction would reach for.
    requireJustification: true,
    scope: "internal",
    execute: async (input, ctx) => {
      if (requireSources && !hasSourcesHeading(input.body)) {
        // Deterministic write-path governance (§3.3): no citation, no write.
        return (
          "wiki_write rejected: the body has no `## Sources` section. This wiki " +
          "requires cited knowledge — add a `## Sources` heading listing where " +
          "this came from, then retry. Nothing was written."
        );
      }
      const existing = await store.get(input.slug).catch(() => null);
      const createdBy = createdByFrom(ctx);
      try {
        const result = await store.write({
          slug: input.slug,
          title: input.title,
          body: input.body,
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.confidenceScore !== undefined ? { confidence: input.confidenceScore } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          sources: extractSources(input.body),
          ...(existing !== null ? { expectedVersion: existing.version } : {}),
          ...(createdBy !== undefined ? { createdBy } : {}),
        });
        await emit({
          slug: result.slug,
          version: result.version,
          action: "write",
          ...(input.editMessage !== undefined ? { editMessage: input.editMessage } : {}),
        });
        const verb =
          existing === null
            ? "created"
            : `updated (superseded v${existing.version} — prior kept in versions/)`;
        const sharedNote =
          input.visibility === "shared"
            ? "\nnote: the local wiki is private by construction — 'shared' visibility only applies on the Thredz backend."
            : "";
        const spaceNote =
          input.space !== undefined
            ? "\nnote: the local wiki is a single unspaced corpus — 'space' only applies on the Thredz backend."
            : "";
        return `wiki_write: ${verb} "${result.slug}" at v${result.version}${sharedNote}${spaceNote}`;
      } catch (err) {
        if (err instanceof WikiVersionConflictError) {
          return `wiki_write failed (stale_article_version) — ${STALE_WRITE_REMEDIATION}`;
        }
        throw err;
      }
    },
  });

  const list: RegisteredTool = buildTool({
    name: "wiki_list",
    description:
      "List/filter wiki articles. For REFLECTION passes: sort by `updated` ascending to surface the stalest articles, or filter by tags/status to audit a topic.",
    inputSchema: listSchema,
    readOnly: true,
    scope: "internal",
    execute: async (input) => {
      const limit = input.limit ?? 25;
      const sort = input.sort ?? "updated";
      const order = input.order ?? "asc"; // thredz default: stalest first
      const status =
        input.status === "draft" ||
        input.status === "published" ||
        input.status === "review" ||
        input.status === "archived"
          ? input.status
          : "all";
      const tags = (input.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      let refs = [
        ...(await store.list({
          staleFirst: order === "asc",
          status,
          ...(tags.length > 0 ? { tags } : {}),
        })),
      ];
      if (input.query !== undefined && input.query.trim() !== "") {
        const matched = new Set((await store.search(input.query)).map((r) => r.slug));
        refs = refs.filter((r) => matched.has(r.slug));
      }
      const notes: string[] = [];
      if (sort === "title") {
        refs.sort((a, b) => a.title.localeCompare(b.title) * (order === "desc" ? -1 : 1));
      } else if (sort !== "updated") {
        notes.push(`note: sort "${sort}" is not supported locally — sorted by updated instead.`);
      }
      const rows = refs.slice(0, limit);
      const lines = [
        `${rows.length}/${refs.length} article(s) (sort ${sort === "title" ? "title" : "updated"} ${order}):`,
        ...notes,
      ];
      for (const ref of rows) lines.push(`  • ${ref.updatedAt}  ${refLine(ref)}`);
      if (rows.length === 0) lines.push("  (none)");
      return lines.join("\n");
    },
  });

  const related: RegisteredTool = buildTool({
    name: "wiki_related",
    description:
      "Find articles related to a slug by tags + semantic similarity. Use in reflection to detect duplicates or contradictions to reconcile.",
    inputSchema: relatedSchema,
    readOnly: true,
    scope: "internal",
    execute: async (input) => {
      let refs: Awaited<ReturnType<WikiStore["related"]>>;
      try {
        refs = await store.related(input.slug);
      } catch {
        return `no wiki article with slug "${input.slug}"`;
      }
      if (refs.length === 0) return `no articles related to "${input.slug}"`;
      const lines = [`${refs.length} article(s) related to "${input.slug}":`];
      for (const ref of refs) lines.push(`  • (${ref.relatedScore.toFixed(2)}) ${refLine(ref)}`);
      return lines.join("\n");
    },
  });

  const setSignals: RegisteredTool = buildTool({
    name: "wiki_set_signals",
    description:
      "Set quality signals on an article after verification: `verified` (fact-checked against a primary source) and/or `confidenceScore` (0–1). Use in reflection to promote or demote knowledge.",
    inputSchema: setSignalsSchema,
    destructive: true,
    // Pillar 3 intent gate (§7.4): promoting poisoned knowledge to
    // "verified" (or demoting good knowledge) is a high-leverage mutation.
    requireJustification: true,
    scope: "internal",
    execute: async (input) => {
      if (input.verified === undefined && input.confidenceScore === undefined) {
        return "wiki_set_signals: pass at least one of `verified` / `confidenceScore`.";
      }
      try {
        await store.setSignals(input.slug, {
          ...(input.verified !== undefined ? { verified: input.verified } : {}),
          ...(input.confidenceScore !== undefined ? { confidence: input.confidenceScore } : {}),
        });
      } catch {
        return `no wiki article with slug "${input.slug}"`;
      }
      const article = await store.get(input.slug);
      await emit({
        slug: input.slug,
        version: article?.version ?? 0,
        action: "set_signals",
      });
      const bits: string[] = [];
      if (input.verified !== undefined) bits.push(`verified=${input.verified}`);
      if (input.confidenceScore !== undefined) bits.push(`confidence=${input.confidenceScore}`);
      return `wiki_set_signals: "${input.slug}" → ${bits.join(", ")} (v${article?.version ?? "?"} unchanged — signals never bump the version)`;
    },
  });

  const stats: RegisteredTool = buildTool({
    name: "wiki_stats",
    description:
      "Corpus health: article/category/tag/version counts. Useful in a reflection summary.",
    inputSchema: statsSchema,
    readOnly: true,
    scope: "internal",
    execute: async () => {
      const s = await store.stats();
      return [
        `wiki stats (${opts.specName}):`,
        `  articles:        ${s.articles} (published ${s.byStatus.published}, draft ${s.byStatus.draft}, review ${s.byStatus.review}, archived ${s.byStatus.archived})`,
        `  prior versions:  ${s.priorVersions}`,
        `  unique tags:     ${s.uniqueTags}`,
        `  verified:        ${s.verified}`,
        `  avg confidence:  ${s.averageConfidence.toFixed(2)}`,
        `  link edges:      ${s.links}`,
      ].join("\n");
    },
  });

  const logKnowledgeGap: RegisteredTool = buildTool({
    name: "log_knowledge_gap",
    description:
      "Record a knowledge gap when the expert could NOT confidently answer. These gaps become the highest-priority items for the next study pass — this is how the expert learns WHAT to learn.",
    inputSchema: logGapSchema,
    // sideEffect audit-and-allow (§3.2/§7.4): it writes durable state, so it
    // is destructive for permission purposes, but deliberately NOT
    // justification-gated — logging a gap must stay the honest low-friction
    // path (friction here trains the model to bluff instead).
    destructive: true,
    scope: "internal",
    execute: async (input, ctx) => {
      const gap: KnowledgeGap = {
        topic: input.topic,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        tags: input.tags ?? [],
        priority: input.priority ?? "medium",
      };
      if (opts.logGap !== undefined) {
        return await opts.logGap(gap);
      }
      // Standalone fallback: the gap lives in the wiki itself under the
      // reserved `gaps/` tag so wiki_list can drive the next STUDY pass.
      const slug = `gap-${slugifyTopic(gap.topic)}`;
      const existing = await store.get(slug).catch(() => null);
      const at = now().toISOString();
      const entry = `- ${at} (${gap.priority}) ${gap.detail ?? "(no detail)"}`;
      const body =
        existing === null
          ? `Knowledge gap: ${gap.topic}\n\n## Occurrences\n\n${entry}`
          : `${existing.body}\n${entry}`;
      const createdBy = createdByFrom(ctx);
      const result = await store.write({
        slug,
        title: `Study gap: ${gap.topic}`,
        body,
        tags: [GAPS_TAG, `priority:${gap.priority}`, ...gap.tags],
        status: "draft",
        ...(existing !== null ? { expectedVersion: existing.version } : {}),
        ...(createdBy !== undefined ? { createdBy } : {}),
      });
      await emit({ slug: result.slug, version: result.version, action: "gap" });
      return `logged knowledge gap "${gap.topic}" → ${result.slug} (v${result.version}, priority ${gap.priority}) — find it with wiki_list tags=${GAPS_TAG}`;
    },
  });

  return {
    recall,
    semanticSearch,
    search,
    get,
    write,
    list,
    related,
    setSignals,
    stats,
    logKnowledgeGap,
    all: [
      recall,
      semanticSearch,
      search,
      get,
      write,
      list,
      related,
      setSignals,
      stats,
      logKnowledgeGap,
    ],
    store,
  };
}
