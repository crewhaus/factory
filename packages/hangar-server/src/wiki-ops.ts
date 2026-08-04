/**
 * M3 · MEMORY — the local wiki: editor, versions, link graph, signals, the
 * REFLECT maintenance queue, and archiving.
 *
 * Owned by the Memory implementer. The M1 read side (`wikiView`,
 * `wikiArticle` in `memory.ts`) stays where it is.
 *
 * ---------------------------------------------------------------------------
 * THE OPTIMISTIC-CONCURRENCY CONTRACT
 * ---------------------------------------------------------------------------
 * Every wiki write carries `expectedVersion`. When the on-disk version has
 * moved on, the store answers `stale_article_version` — and that is a
 * FIRST-CLASS STATE, not an error:
 *
 *   1. re-read the article at its current version,
 *   2. show the operator what changed under them,
 *   3. offer retry with the new `expectedVersion`.
 *
 * So a conflict comes back as a 200 CARRYING that state — `{ ok: false,
 * code: "stale_article_version", currentVersion, current, diff }` — not as a
 * bare status the client has to reverse-engineer. The refusal IS the
 * payload the screen renders; a status code cannot carry the diff, and the
 * console must never have to guess what moved. The UX is identical for the
 * local store and the Thredz backend (`thredz.ts`), deliberately: an
 * operator must not have to learn which backend a harness uses to save an
 * edit.
 *
 * Other wiki rules that are easy to get wrong:
 *   - ARCHIVE, NEVER DELETE. An article leaves the live list by taking the
 *     archived status. Its versions stay. Confirm-gated. The store has no
 *     status-only mutation, so archiving is a content write that keeps the
 *     body byte-identical — and the prior verified/confidence signals are
 *     re-applied afterwards through `setSignals` (metadata-only), so
 *     archiving never silently un-verifies an article.
 *   - `setSignals` is METADATA-ONLY (verified / confidence). It must never
 *     be able to rewrite a body — that is what the editor route is for, and
 *     this module REFUSES a signals body that carries article content.
 *   - the `## Sources` gate is a LOCAL-ONLY rule. It is enforced exactly
 *     where the agent's own `wiki_write` enforces it (`memory.wiki.
 *     requireSources`) and badged as local so nobody reads it as a Thredz
 *     rule.
 *   - `index.json` is a rebuildable CACHE. It is read for titles and link
 *     edges, but a missing or stale entry means "rebuild from the articles
 *     on disk", never "the article does not exist".
 *   - the REFLECT queue is stale-first ordering over that scan, not a
 *     separate store.
 *
 * Bodies are prose: masked with `maskText` on the way out (key-based
 * redaction cannot see into a paragraph), and never echoed into a log line.
 *
 * ---------------------------------------------------------------------------
 * TOLERANT READS, LIBRARY WRITES
 * ---------------------------------------------------------------------------
 * Reads parse with the store's own `parseArticle` / `extractWikilinks` (the
 * format authority) but degrade to a raw document when an article has no
 * frontmatter, so one hand-written file never blanks the browser. Every
 * WRITE goes through `@crewhaus/wiki-store`, which snapshots the outgoing
 * version into `versions/<slug>/<n>.md` FIRST and takes the advisory lock at
 * save — never across the operator's typing.
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type WikiArticle,
  type WikiArticleStatus,
  type WikiStore,
  WikiVersionConflictError,
  createWikiStore,
  extractWikilinks,
  parseArticle,
} from "@crewhaus/wiki-store";
import { MAX_TEXT_BYTES } from "./constants";
import { HttpError } from "./http";
import { readTextCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { requireBoolean, requireString } from "./m3";
import { maskText } from "./mask";
import {
  containedPath,
  describeFailure,
  harnessDirOf,
  harnessSpecName,
  isStoreName,
  lineDiff,
  listDirSafe,
  parseDurationMs,
  readBase,
  readJsonSafe,
  resolveStoreDir,
  specBlock,
  specScalar,
} from "./memory-ops";
import { readSpecYaml } from "./schedulers";

/** Cap on articles folded into one screen (a REFLECT queue is a screen). */
const MAX_WIKI_ARTICLES = 500;
/** Cap on versions listed for one article. */
const MAX_WIKI_VERSIONS = 200;

/** Slugs are kebab-case AND double as file names (the store's own rule). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

const VERB = "crewhaus run (the agent's wiki_write tool), or edit an article here";

// ---------------------------------------------------------------------------
// where the wiki lives
// ---------------------------------------------------------------------------

type WikiTarget = {
  /** The store directory (`…/wiki/<spec>` or the older flat `…/wiki`). */
  readonly dir: string;
  readonly layout: "spec-scoped" | "flat";
  /** Harness-relative prefix for per-file containment checks. */
  readonly prefix: readonly string[];
};

/**
 * Resolve this harness's wiki. An existing tree wins (either layout); when
 * there is none, the spec-scoped layout is the target a write would create —
 * which is what the store itself does.
 */
function wikiTarget(ctx: M3Context, specName: string): WikiTarget {
  const found = resolveStoreDir(ctx, "wiki", specName, ["articles", "index.json"]);
  if (found !== undefined) {
    return {
      dir: found.dir,
      layout: found.layout,
      prefix: found.layout === "flat" ? [".crewhaus", "wiki"] : [".crewhaus", "wiki", specName],
    };
  }
  const dir = containedPath(ctx, [".crewhaus", "wiki", specName]);
  return {
    dir: dir ?? join(harnessDirOf(ctx), ".crewhaus", "wiki", specName),
    layout: "spec-scoped",
    prefix: [".crewhaus", "wiki", specName],
  };
}

/**
 * The store for a resolved target. `createWikiStore` composes its directory
 * as `<rootDir>/<specName>`, so an older FLAT tree is addressed by naming
 * its own basename — the store then reads and writes exactly the files that
 * are already there instead of a second, parallel wiki.
 */
function wikiStoreFor(ctx: M3Context, target: WikiTarget): WikiStore {
  const storeName = basename(target.dir);
  if (!isStoreName(storeName)) throw new HttpError(400, "invalid wiki store name");
  return createWikiStore({
    rootDir: dirname(target.dir),
    specName: storeName,
    now: () => new Date(ctx.now()),
  });
}

function validSlug(ctx: M3Context): string {
  const slug = ctx.params["slug"] ?? "";
  if (!SLUG_RE.test(slug)) {
    throw new HttpError(400, "invalid slug — wiki slugs are kebab-case ([a-z0-9][a-z0-9-]*)");
  }
  return slug;
}

// ---------------------------------------------------------------------------
// tolerant article reads
// ---------------------------------------------------------------------------

export type ArticleRead = {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly status: WikiArticleStatus;
  readonly version: number;
  readonly verified: boolean;
  readonly confidence: number;
  readonly sources: readonly string[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly createdBy: { sessionId: string; agentIdentity: string | null } | null;
  /** True when the file carries no parseable frontmatter — rendered as a
   *  document, and flagged, rather than hidden. */
  readonly malformed: boolean;
  readonly truncated: boolean;
};

/** The first `# heading` in a body, as a fallback title. */
function headingTitle(body: string, fallback: string): string {
  for (const line of body.split("\n")) {
    const m = line.match(/^#{1,3}\s+(.*)$/);
    if (m !== null) return (m[1] ?? "").trim() || fallback;
  }
  return fallback;
}

/**
 * Read one article file tolerantly. Nothing is written.
 *
 * `raw: true` skips the masking, and is ONLY for text that is about to be
 * written back (the archive round-trip re-writes the body byte-for-byte).
 * Masking is an OUTPUT transform: persisting a masked span would replace
 * whatever it hid, which is silent data loss dressed up as safety. A raw
 * read must never reach a response.
 */
function readArticleFile(
  path: string | undefined,
  slug: string,
  opts: { raw?: boolean } = {},
): ArticleRead | null {
  if (path === undefined || !existsSync(path)) return null;
  const mask = opts.raw === true ? (t: string): string => t : maskText;
  const { text, truncated } = readTextCapped(path, MAX_TEXT_BYTES);
  let mtime: string | null = null;
  try {
    mtime = statSync(path).mtime.toISOString();
  } catch {
    mtime = null;
  }
  try {
    const parsed: WikiArticle = parseArticle(text);
    return {
      slug: parsed.slug,
      title: mask(parsed.title),
      body: mask(parsed.body),
      tags: parsed.tags.map((t) => mask(t)),
      status: parsed.status,
      version: parsed.version,
      verified: parsed.verified,
      confidence: parsed.confidence,
      sources: parsed.sources.map((s) => mask(s)),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      createdBy:
        parsed.createdBy === undefined
          ? null
          : {
              sessionId: parsed.createdBy.sessionId,
              agentIdentity: parsed.createdBy.agentIdentity ?? null,
            },
      malformed: false,
      truncated,
    };
  } catch {
    // No frontmatter (a hand-written file, or a pre-store article): render it
    // as the document it is. A malformed article must never blank the wiki.
    return {
      slug,
      title: mask(headingTitle(text, slug)),
      body: mask(text),
      tags: [],
      status: "published",
      version: 1,
      verified: false,
      confidence: 0.5,
      sources: [],
      createdAt: null,
      updatedAt: mtime,
      createdBy: null,
      malformed: true,
      truncated,
    };
  }
}

/** Every article slug on disk — the authority the index only caches. */
function articleSlugs(target: WikiTarget): string[] {
  return listDirSafe(join(target.dir, "articles"))
    .filter((n) => n.endsWith(".md"))
    .map((n) => n.slice(0, -".md".length))
    .filter((slug) => SLUG_RE.test(slug))
    .slice(0, MAX_WIKI_ARTICLES);
}

/** `index.json`'s article map, whichever of the two shapes it carries. */
function indexArticles(target: WikiTarget): Record<string, Record<string, unknown>> {
  const raw = readJsonSafe(join(target.dir, "index.json"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const holder = (raw as Record<string, unknown>)["articles"] ?? raw;
  if (typeof holder !== "object" || holder === null || Array.isArray(holder)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [slug, entry] of Object.entries(holder as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      out[slug] = entry as Record<string, unknown>;
    }
  }
  return out;
}

export type WikiRow = {
  readonly slug: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly status: WikiArticleStatus;
  readonly version: number;
  readonly verified: boolean;
  readonly confidence: number;
  readonly updatedAt: string | null;
  readonly staleMs: number | null;
  readonly links: readonly string[];
  /** The local-only `## Sources` gate: does the body carry the heading. */
  readonly hasSources: boolean;
  readonly malformed: boolean;
  /** True when index.json disagreed with the file (a cache miss, not a fault). */
  readonly indexStale: boolean;
};

/** Fold every article into a row, rebuilding what the index cache lacks. */
function wikiRows(ctx: M3Context, target: WikiTarget, nowMs: number): WikiRow[] {
  const cached = indexArticles(target);
  const rows: WikiRow[] = [];
  for (const slug of articleSlugs(target)) {
    // Per FILE: a listed article name can be a symlink out of the harness.
    const article = readArticleFile(
      containedPath(ctx, [...target.prefix, "articles", `${slug}.md`]),
      slug,
    );
    if (article === null) continue;
    const entry = cached[slug];
    const cachedVersion =
      typeof entry?.["version"] === "number" ? (entry["version"] as number) : null;
    const updatedAt = article.updatedAt;
    const updatedMs = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
    rows.push({
      slug,
      title: article.title,
      tags: article.tags,
      status: article.status,
      version: article.version,
      verified: article.verified,
      confidence: article.confidence,
      updatedAt,
      staleMs: Number.isNaN(updatedMs) ? null : nowMs - updatedMs,
      links: extractWikilinks(article.body, slug),
      hasSources: /^##\s+Sources\s*$/m.test(article.body),
      malformed: article.malformed,
      indexStale: entry === undefined || cachedVersion !== article.version,
    });
  }
  return rows;
}

/**
 * `memory.wiki.requireSources` — the LOCAL-ONLY `## Sources` gate.
 *
 * Enforced here because the agent's own `wiki_write` enforces it: a console
 * that let a sourceless body through would make the rule a lie, and the
 * operator would discover the divergence only when the agent refused the
 * same edit. A `learning:` block sets the same gate at lower time (unless it
 * is explicitly disabled), so the presence of one counts.
 */
function sourcesRequired(ctx: M3Context): boolean {
  const yamlText = readSpecYaml(harnessDirOf(ctx));
  const wiki = specBlock(yamlText, ["memory", "wiki"]);
  if (wiki !== undefined && specScalar(wiki, "requireSources") === "true") return true;
  const learning = specBlock(yamlText, ["learning"]);
  return learning !== undefined && specScalar(learning, "enabled") !== "false";
}

// ---------------------------------------------------------------------------
// the write side
// ---------------------------------------------------------------------------

/** A store refusal, classified. Every one is a STATE the editor renders. */
function writeRefusal(
  err: unknown,
  slug: string,
  current: ArticleRead | null,
): Record<string, unknown> {
  if (err instanceof WikiVersionConflictError) {
    return {
      ok: false,
      code: "stale_article_version",
      slug,
      expectedVersion: err.expectedVersion ?? null,
      currentVersion: err.currentVersion ?? null,
      current,
      note: "the article moved under you — re-read it, look at what changed, then retry with the current version",
    };
  }
  return {
    ok: false,
    code: "wiki_store_refused",
    slug,
    current,
    note: describeFailure(err),
  };
}

/**
 * `PUT /api/h/:id/memory/wiki/:slug` — create or update an article.
 *
 * Body: `{ body, title?, tags?, status?, sources?, confidence?,
 * expectedVersion }`. Written through `@crewhaus/wiki-store`, which takes
 * the advisory lock at SAVE (not at open) and freezes the outgoing version
 * into `versions/<slug>/<n>.md` before replacing the file.
 *
 * A version mismatch answers 200 with the `stale_article_version` state and
 * the diff against what is on disk now, so the client can run the
 * re-read-then-reapply retry without a second round trip.
 */
export const wikiWrite: M3Handler = async (ctx) => {
  const slug = validSlug(ctx);
  const body = requireString(ctx.body, "body");
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  const currentPath = containedPath(ctx, [...target.prefix, "articles", `${slug}.md`]);
  const current = readArticleFile(currentPath, slug);
  // A default that is about to be WRITTEN (the title carried over from the
  // existing article) must come from the unmasked read.
  const currentRaw = readArticleFile(currentPath, slug, { raw: true });

  const rawVersion = ctx.body["expectedVersion"];
  const expectedVersion =
    typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0
      ? rawVersion
      : undefined;
  const rawTitle = ctx.body["title"];
  const title =
    typeof rawTitle === "string" && rawTitle.trim() !== ""
      ? rawTitle
      : (currentRaw?.title ?? headingTitle(body, slug));
  const rawTags = ctx.body["tags"];
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : undefined;
  const rawStatus = ctx.body["status"];
  const status =
    rawStatus === "draft" ||
    rawStatus === "published" ||
    rawStatus === "review" ||
    rawStatus === "archived"
      ? (rawStatus as WikiArticleStatus)
      : undefined;
  const rawSources = ctx.body["sources"];
  const sources = Array.isArray(rawSources)
    ? rawSources.filter((s): s is string => typeof s === "string")
    : undefined;
  const rawConfidence = ctx.body["confidence"];
  const confidence =
    typeof rawConfidence === "number" && rawConfidence >= 0 && rawConfidence <= 1
      ? rawConfidence
      : undefined;

  const required = sourcesRequired(ctx);
  const hasSources = /^##\s+Sources\s*$/m.test(body);
  if (required && !hasSources) {
    // The same deterministic gate the agent's own wiki_write enforces — a
    // console that let a sourceless body through would make the rule a lie.
    return {
      ok: false,
      code: "missing_sources",
      slug,
      backend: "local",
      current,
      note: "this harness requires a `## Sources` heading on every wiki body (memory.wiki.requireSources — a LOCAL rule; the Thredz backend does not apply it)",
    };
  }

  try {
    const result = await wikiStoreFor(ctx, target).write({
      slug,
      title,
      body,
      ...(tags !== undefined ? { tags } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(sources !== undefined ? { sources } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    return {
      ok: true,
      slug: result.slug,
      version: result.version,
      backend: "local",
      layout: target.layout,
      previousVersion: current?.version ?? null,
      diff: lineDiff(current?.body ?? "", maskText(body)),
      sourcesGate: { required, present: hasSources },
      note:
        current === null
          ? "article created at version 1"
          : `version ${result.version} written; version ${current.version} is frozen under versions/${slug}/ and verified was reset (a new version is a new claim)`,
    };
  } catch (err) {
    return writeRefusal(err, slug, current);
  }
};

/**
 * `GET /api/h/:id/memory/wiki/:slug/versions` — the version list.
 *
 * From `wiki/versions/<slug>/<n>.md`. Each entry: version, timestamp, author
 * (agent session vs operator) and size. Containment-checked per file.
 */
export const wikiVersions: M3Handler = (ctx) => {
  const slug = validSlug(ctx);
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  const current = readArticleFile(
    containedPath(ctx, [...target.prefix, "articles", `${slug}.md`]),
    slug,
  );
  const versionsDir = join(target.dir, "versions", slug);
  const versions: Array<Record<string, unknown>> = [];
  for (const name of listDirSafe(existsSync(versionsDir) ? versionsDir : undefined)) {
    if (!name.endsWith(".md")) continue;
    const stem = name.slice(0, -".md".length);
    if (!/^\d+$/.test(stem)) continue;
    if (versions.length >= MAX_WIKI_VERSIONS) break;
    const path = containedPath(ctx, [...target.prefix, "versions", slug, name]);
    const snapshot = readArticleFile(path, slug);
    if (snapshot === null || path === undefined) continue;
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = 0;
    }
    versions.push({
      version: Number(stem),
      title: snapshot.title,
      updatedAt: snapshot.updatedAt,
      author: snapshot.createdBy === null ? "operator" : "agent",
      sessionId: snapshot.createdBy?.sessionId ?? null,
      agentIdentity: snapshot.createdBy?.agentIdentity ?? null,
      bytes,
    });
  }
  versions.sort((a, b) => Number(b["version"]) - Number(a["version"]));
  return {
    ...readBase(
      versions.length > 0,
      versions.length === 0
        ? current === null
          ? "no article with that slug yet"
          : "this article has never been edited — version 1 is still the live file"
        : null,
      VERB,
    ),
    slug,
    currentVersion: current?.version ?? null,
    versions,
    truncated: versions.length >= MAX_WIKI_VERSIONS,
  };
};

/**
 * `GET /api/h/:id/memory/wiki/:slug/versions/:version` — one frozen version
 * with its diff against the live article. Masked as prose.
 */
export const wikiVersion: M3Handler = (ctx) => {
  const slug = validSlug(ctx);
  const version = ctx.params["version"] ?? "";
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  const current = readArticleFile(
    containedPath(ctx, [...target.prefix, "articles", `${slug}.md`]),
    slug,
  );
  if (!/^\d+$/.test(version)) {
    return {
      ...readBase(false, "wiki versions are integers — `1`, `2`, `3`", VERB),
      slug,
      version,
      body: "",
      diff: "",
      author: null,
      updatedAt: null,
      currentVersion: current?.version ?? null,
    };
  }
  const snapshot = readArticleFile(
    containedPath(ctx, [...target.prefix, "versions", slug, `${version}.md`]),
    slug,
  );
  if (snapshot === null) {
    return {
      ...readBase(false, `no frozen version ${version} for this article`, VERB),
      slug,
      version,
      body: "",
      diff: "",
      author: null,
      updatedAt: null,
      currentVersion: current?.version ?? null,
    };
  }
  return {
    ...readBase(true, null, VERB),
    slug,
    version,
    title: snapshot.title,
    body: snapshot.body,
    tags: snapshot.tags,
    status: snapshot.status,
    author: snapshot.createdBy === null ? "operator" : "agent",
    sessionId: snapshot.createdBy?.sessionId ?? null,
    updatedAt: snapshot.updatedAt,
    currentVersion: current?.version ?? null,
    // Old → live, so the diff reads "what has happened since".
    diff: lineDiff(snapshot.body, current?.body ?? ""),
    truncated: snapshot.truncated,
  };
};

/**
 * `GET /api/h/:id/memory/wiki/:slug/links` — the one-hop link graph.
 *
 * Outbound `[[wikilinks]]` extracted from the body plus the backlinks other
 * articles carry. The `index.json` `links[]` cache is consulted, but the
 * scan is the authority: a missing edge is a CACHE MISS, never a missing
 * article, so the graph is rebuilt from the bodies on disk.
 */
export const wikiLinks: M3Handler = (ctx) => {
  const slug = validSlug(ctx);
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  const rows = wikiRows(ctx, target, ctx.now());
  const self = rows.find((r) => r.slug === slug);
  const known = new Set(rows.map((r) => r.slug));
  const titleOf = (s: string): string => rows.find((r) => r.slug === s)?.title ?? s;

  const links: Array<Record<string, unknown>> = [];
  for (const out of self?.links ?? []) {
    links.push({
      slug: out,
      direction: "out",
      exists: known.has(out),
      title: titleOf(out),
      note: known.has(out) ? null : "the link points at an article that has not been written yet",
    });
  }
  for (const row of rows) {
    if (row.slug === slug || !row.links.includes(slug)) continue;
    links.push({ slug: row.slug, direction: "in", exists: true, title: row.title, note: null });
  }
  const cachedEdges = indexArticles(target)[slug]?.["links"];
  const indexStale =
    !Array.isArray(cachedEdges) ||
    cachedEdges.length !== (self?.links.length ?? 0) ||
    (self?.links ?? []).some((l) => !cachedEdges.includes(l));
  return {
    ...readBase(
      self !== undefined,
      self === undefined
        ? "no article with that slug yet"
        : links.length === 0
          ? "this article neither links out nor is linked to — [[wikilinks]] in a body make the graph"
          : null,
      VERB,
    ),
    slug,
    links,
    outbound: (self?.links ?? []).length,
    backlinks: links.filter((l) => l["direction"] === "in").length,
    // A stale index is a hint to rebuild, never a reason to hide an edge.
    indexStale,
  };
};

/**
 * `POST /api/h/:id/memory/wiki/:slug/signals` — verified/confidence signals.
 *
 * Body: `{ verified?, confidence? }` through the store's `setSignals`, which
 * bumps no version and freezes no snapshot (the body is untouched).
 * METADATA ONLY — a body carrying article content is REFUSED here, because
 * the one thing this route must never become is a second, unversioned
 * editor.
 */
export const wikiSignals: M3Handler = async (ctx) => {
  const slug = validSlug(ctx);
  for (const forbidden of ["body", "title", "tags", "status", "sources"]) {
    if (ctx.body[forbidden] !== undefined) {
      throw new HttpError(
        400,
        `"${forbidden}" is article CONTENT — signals are metadata only; use PUT /memory/wiki/${slug}`,
      );
    }
  }
  const rawVerified = ctx.body["verified"];
  const rawConfidence = ctx.body["confidence"];
  if (rawVerified === undefined && rawConfidence === undefined) {
    throw new HttpError(400, 'send "verified" (boolean) and/or "confidence" (0–1)');
  }
  if (rawVerified !== undefined && typeof rawVerified !== "boolean") {
    throw new HttpError(400, '"verified" must be a boolean');
  }
  if (
    rawConfidence !== undefined &&
    (typeof rawConfidence !== "number" || rawConfidence < 0 || rawConfidence > 1)
  ) {
    throw new HttpError(400, '"confidence" must be a number in [0, 1]');
  }
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  try {
    await wikiStoreFor(ctx, target).setSignals(slug, {
      ...(typeof rawVerified === "boolean" ? { verified: rawVerified } : {}),
      ...(typeof rawConfidence === "number" ? { confidence: rawConfidence } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      code: "signals_refused",
      slug,
      note: describeFailure(err),
    };
  }
  const after = readArticleFile(
    containedPath(ctx, [...target.prefix, "articles", `${slug}.md`]),
    slug,
  );
  return {
    ok: true,
    slug,
    verified: after?.verified ?? null,
    confidence: after?.confidence ?? null,
    version: after?.version ?? null,
    note: "signals are metadata: no version bump, no snapshot, the body untouched",
  };
};

/**
 * `POST /api/h/:id/memory/wiki/:slug/archive` — archive (never delete).
 *
 * Body: `{ archived: boolean, confirm }`. Flips the article's status through
 * the store. Un-archiving is the same route with `archived: false`, which is
 * exactly why deletion is unnecessary.
 *
 * The store has no status-only mutation, so this is a content write with the
 * body kept byte-identical — it takes a version, which is the store's whole
 * supersede-never-delete model. A content write also RESETS `verified`, so
 * the prior signals are re-applied afterwards through `setSignals`:
 * archiving must not silently un-verify an article.
 */
export const wikiArchive: M3Handler = async (ctx) => {
  const slug = validSlug(ctx);
  const archived = requireBoolean(ctx.body, "archived");
  if (requireBoolean(ctx.body, "confirm") !== true) {
    throw new HttpError(409, 'archiving an article needs "confirm": true');
  }
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  const articlePath = containedPath(ctx, [...target.prefix, "articles", `${slug}.md`]);
  const current = readArticleFile(articlePath, slug);
  // The round-trip reads RAW: the archive write re-writes the body, and a
  // masked span written back would replace what it hid.
  const raw = readArticleFile(articlePath, slug, { raw: true });
  if (current === null || raw === null) {
    return {
      ok: false,
      code: "no_such_article",
      slug,
      note: "no article with that slug — nothing to archive",
    };
  }
  const store = wikiStoreFor(ctx, target);
  try {
    const result = await store.write({
      slug,
      title: raw.title,
      body: raw.body,
      tags: [...raw.tags],
      sources: [...raw.sources],
      confidence: raw.confidence,
      status: archived ? "archived" : "published",
      expectedVersion: raw.version,
    });
    if (current.verified) {
      // Restore the fact-checked flag the content write reset. Metadata only.
      await store.setSignals(slug, { verified: true, confidence: current.confidence });
    }
    return {
      ok: true,
      slug,
      archived,
      version: result.version,
      note: archived
        ? "archived — it leaves the live list, every version stays on disk, and un-archiving is this same call with archived: false"
        : "restored to published",
    };
  } catch (err) {
    return writeRefusal(err, slug, current);
  }
};

/**
 * `GET /api/h/:id/memory/reflect` — the stale-first REFLECT queue.
 *
 * The maintenance view: articles ordered by staleness, with `?tags=`,
 * `?status=` and `?q=` applied SERVER-side so a large wiki does not ship
 * wholesale to the browser. A read over the article scan (index.json is a
 * cache, consulted and never rewritten).
 *
 * The staleness threshold is the consolidation cadence when the spec
 * declares one (`memory.dream.every` is when the maintenance pass actually
 * runs); otherwise a 30-day default, and the payload says which.
 */
export const wikiReflect: M3Handler = (ctx) => {
  const specName = harnessSpecName(ctx);
  const target = wikiTarget(ctx, specName);
  const nowMs = ctx.now();
  const rows = wikiRows(ctx, target, nowMs);

  const wantTags = (ctx.query.get("tags") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const wantStatus = ctx.query.get("status") ?? "all";
  const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (wantStatus !== "all" && r.status !== wantStatus) return false;
    if (wantTags.length > 0 && !wantTags.every((t) => r.tags.includes(t))) return false;
    if (q !== "" && !r.title.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    return true;
  });

  const dream = specBlock(readSpecYaml(harnessDirOf(ctx)), ["memory", "dream"]);
  const cadence = dream === undefined ? undefined : specScalar(dream, "every");
  const cadenceMs = parseDurationMs(cadence);
  // Never finer than a day: the maintenance pass is a daily-or-slower habit,
  // and an hour-scale threshold would mark a whole wiki stale every morning.
  const thresholdMs = cadenceMs === null ? 30 * 86_400_000 : Math.max(86_400_000, cadenceMs);

  const articles = filtered
    .slice()
    .sort((a, b) => (b.staleMs ?? -1) - (a.staleMs ?? -1) || a.slug.localeCompare(b.slug))
    .map((r) => ({ ...r, stale: r.staleMs !== null && r.staleMs > thresholdMs }));

  const allTags = [...new Set(rows.flatMap((r) => r.tags))].sort();
  return {
    ...readBase(
      rows.length > 0,
      rows.length === 0
        ? "no wiki articles yet — the REFLECT queue is what the agent maintains once there are"
        : articles.length === 0
          ? "no article matches these filters"
          : null,
      "crewhaus run (then /reflect)",
    ),
    articles,
    total: rows.length,
    filters: { tags: wantTags, status: wantStatus, q, available: allTags },
    thresholdMs,
    thresholdSource: cadence !== undefined ? "memory.dream.every" : "default (30d)",
    backend: "local",
    layout: target.layout,
    // The `## Sources` gate is a LOCAL rule — badged, never implied of Thredz.
    sourcesGate: sourcesRequired(ctx),
    stale: articles.filter((a) => a.stale).length,
  };
};
