/**
 * M3 · MEMORY — the local wiki: editor, versions, link graph, signals, the
 * REFLECT maintenance queue, and archiving.
 *
 * STUBS. Owned by the Memory implementer. The M1 read side (`wikiView`,
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
 * The UX is identical for the local store and the Thredz backend
 * (`thredz.ts`), deliberately — an operator must not have to learn which
 * backend a harness uses in order to save an edit.
 *
 * Other wiki rules that are easy to get wrong:
 *   - ARCHIVE, NEVER DELETE. An article leaves the live list by taking the
 *     archived status. Its versions stay. Confirm-gated.
 *   - `setSignals` is METADATA-ONLY (verified / confidence). It must never
 *     be able to rewrite a body — that is what the editor route is for.
 *   - the `## Sources` gate is a LOCAL-ONLY rule. Surface it as a badge on
 *     local articles and do not pretend it applies to the Thredz backend.
 *   - `index.json` is a rebuildable CACHE. Read it for speed, but a missing
 *     or stale entry means "rebuild", never "the article does not exist".
 *   - the REFLECT queue is stale-first ordering over the index, not a
 *     separate store.
 *
 * Bodies are prose: mask with `maskText` on the way out (key-based redaction
 * cannot see into a paragraph), and never echo a body back into a log line.
 *
 * Implementation needs `@crewhaus/wiki-store` added to this package's
 * dependencies + tsconfig references.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `PUT /api/h/:id/memory/wiki/:slug` — create or update an article.
 *
 * Body: `{ body, title?, tags?, status?, expectedVersion }`. Written through
 * `@crewhaus/wiki-store` (which takes the advisory lock at SAVE, not at
 * open). A version mismatch answers 409 with the current version + a diff so
 * the client can run the re-read-retry contract above.
 */
export const wikiWrite: M3Handler = () => notImplemented("wiki write");

/**
 * `GET /api/h/:id/memory/wiki/:slug/versions` — the version list.
 *
 * From `wiki/versions/<slug>/<n>.md`. Each entry: version, timestamp, author
 * (agent vs operator), and size. Containment-checked per file.
 */
export const wikiVersions: M3Handler = () => notImplemented("wiki versions");

/**
 * `GET /api/h/:id/memory/wiki/:slug/versions/:version` — one version, with
 * its diff against the live article. Masked as prose.
 */
export const wikiVersion: M3Handler = () => notImplemented("wiki version diff");

/**
 * `GET /api/h/:id/memory/wiki/:slug/links` — the one-hop link graph.
 *
 * Outbound links from the article's frontmatter/body plus the backlinks the
 * `index.json` `links[]` cache records. Rebuild rather than trust a stale
 * index; a missing edge is a cache miss, not a missing article.
 */
export const wikiLinks: M3Handler = () => notImplemented("wiki link graph");

/**
 * `POST /api/h/:id/memory/wiki/:slug/signals` — verified/confidence signals.
 *
 * Body: `{ verified?, confidence? }` through the store's `setSignals`.
 * METADATA ONLY — this route must reject a body carrying article text.
 */
export const wikiSignals: M3Handler = () => notImplemented("wiki signals");

/**
 * `POST /api/h/:id/memory/wiki/:slug/archive` — archive (never delete).
 *
 * Body: `{ archived: boolean, confirm }`. Flips the article's status through
 * the store. Un-archiving is the same route with `archived: false`, which is
 * exactly why deletion is unnecessary.
 */
export const wikiArchive: M3Handler = () => notImplemented("wiki archive");

/**
 * `GET /api/h/:id/memory/reflect` — the stale-first REFLECT queue.
 *
 * The maintenance view: articles ordered by staleness (last-touched vs the
 * spec's reflect cadence), with tag/status filters applied server-side so a
 * large wiki does not ship wholesale to the browser. A read over the index
 * cache; it never reorders or rewrites it.
 */
export const wikiReflect: M3Handler = () => notImplemented("wiki reflect queue");
